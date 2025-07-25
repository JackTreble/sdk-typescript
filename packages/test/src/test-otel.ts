/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Manual tests to inspect tracing output
 */
import * as http from 'http';
import * as http2 from 'http2';
import { SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Connection, WorkflowClient } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client';
import { instrument } from '@temporalio/interceptors-opentelemetry/lib/instrumentation';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
} from '@temporalio/interceptors-opentelemetry/lib/worker';
import { OpenTelemetrySinks, SpanName, SPAN_DELIMITER } from '@temporalio/interceptors-opentelemetry/lib/workflow';
import { DefaultLogger, InjectedSinks, Runtime } from '@temporalio/worker';
import * as activities from './activities';
import { ConnectionInjectorInterceptor } from './activities/interceptors';
import { RUN_INTEGRATION_TESTS, TestWorkflowEnvironment, Worker } from './helpers';
import * as workflows from './workflows';

async function withFakeGrpcServer(
  fn: (port: number) => Promise<void>,
  requestListener?: (request: http2.Http2ServerRequest, response: http2.Http2ServerResponse) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const srv = http2.createServer();
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = srv.address();
      if (typeof addr === 'string' || addr === null) {
        throw new Error('Unexpected server address type');
      }
      srv.on('request', async (req, res) => {
        if (requestListener) await requestListener(req, res);
        res.statusCode = 200;
        res.addTrailers({
          'grpc-status': '0',
          'grpc-message': 'OK',
        });
        res.write(
          // This is a raw gRPC response, of length 0
          Buffer.from([
            // Frame Type: Data; Not Compressed
            0,
            // Message Length: 0
            0, 0, 0, 0,
          ])
        );
        res.end();
      });
      fn(addr.port)
        .catch((e) => reject(e))
        .finally(() => {
          resolve();

          // The OTel exporter will try to flush metrics on drop, which may result in tons of ERROR
          // messages on the console if the server has had time to complete shutdown before then.
          // Delaying closing the server by 1 second is enough to avoid that situation, and doesn't
          // need to be awaited, no that doesn't slow down tests.
          setTimeout(() => {
            srv.close();
          }, 1000).unref();
        });
    });
  });
}

async function withHttpServer(
  fn: (port: number) => Promise<void>,
  requestListener?: (request: http.IncomingMessage) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const srv = http.createServer();
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = srv.address();
      if (typeof addr === 'string' || addr === null) {
        throw new Error('Unexpected server address type');
      }
      srv.on('request', async (req, res) => {
        if (requestListener) await requestListener(req);
        res.statusCode = 200;
        res.end();
      });
      fn(addr.port)
        .catch((e) => reject(e))
        .finally(() => {
          resolve();

          // The OTel exporter will try to flush metrics on drop, which may result in tons of ERROR
          // messages on the console if the server has had time to complete shutdown before then.
          // Delaying closing the server by 1 second is enough to avoid that situation, and doesn't
          // need to be awaited, no that doesn't slow down tests.
          setTimeout(() => {
            srv.close();
          }, 1000).unref();
        });
    });
  });
}

test.serial('Runtime.install() throws meaningful error when passed invalid metrics.otel.url', async (t) => {
  t.throws(() => Runtime.install({ telemetryOptions: { metrics: { otel: { url: ':invalid' } } } }), {
    instanceOf: TypeError,
    message: /metricsExporter.otel.url/,
  });
});

test.serial('Runtime.install() accepts metrics.otel.url without headers', async (t) => {
  try {
    Runtime.install({ telemetryOptions: { metrics: { otel: { url: 'http://127.0.0.1:1234' } } } });
    t.pass();
  } finally {
    // Cleanup the runtime so that it doesn't interfere with other tests
    await Runtime._instance?.shutdown();
  }
});

test.serial('Exporting OTEL metrics from Core works', async (t) => {
  let resolveCapturedRequest = (_req: http2.Http2ServerRequest) => undefined as void;
  const capturedRequest = new Promise<http2.Http2ServerRequest>((r) => (resolveCapturedRequest = r));
  try {
    await withFakeGrpcServer(async (port: number) => {
      Runtime.install({
        telemetryOptions: {
          metrics: {
            otel: {
              url: `http://127.0.0.1:${port}`,
              headers: {
                'x-test-header': 'test-value',
              },
              metricsExportInterval: 10,
            },
          },
        },
      });

      const localEnv = await TestWorkflowEnvironment.createLocal();
      try {
        const worker = await Worker.create({
          connection: localEnv.nativeConnection,
          workflowsPath: require.resolve('./workflows'),
          taskQueue: 'test-otel',
        });
        const client = new WorkflowClient({
          connection: localEnv.connection,
        });
        await worker.runUntil(async () => {
          await client.execute(workflows.successString, {
            taskQueue: 'test-otel',
            workflowId: uuid4(),
          });
          const req = await Promise.race([
            capturedRequest,
            await new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
          ]);
          t.truthy(req);
          t.is(req?.url, '/opentelemetry.proto.collector.metrics.v1.MetricsService/Export');
          t.is(req?.headers['x-test-header'], 'test-value');
        });
      } finally {
        await localEnv.teardown();
      }
    }, resolveCapturedRequest);
  } finally {
    // Cleanup the runtime so that it doesn't interfere with other tests
    await Runtime._instance?.shutdown();
  }
});

test.serial('Exporting OTEL metrics using OTLP/HTTP from Core works', async (t) => {
  let resolveCapturedRequest = (_req: http.IncomingMessage) => undefined as void;
  const capturedRequest = new Promise<http.IncomingMessage>((r) => (resolveCapturedRequest = r));
  try {
    await withHttpServer(async (port: number) => {
      Runtime.install({
        telemetryOptions: {
          metrics: {
            otel: {
              url: `http://127.0.0.1:${port}/v1/metrics`,
              http: true,
              headers: {
                'x-test-header': 'test-value',
              },
              metricsExportInterval: 10,
            },
          },
        },
      });

      const localEnv = await TestWorkflowEnvironment.createLocal();
      try {
        const worker = await Worker.create({
          connection: localEnv.nativeConnection,
          workflowsPath: require.resolve('./workflows'),
          taskQueue: 'test-otel',
        });
        const client = new WorkflowClient({
          connection: localEnv.connection,
        });
        await worker.runUntil(async () => {
          await client.execute(workflows.successString, {
            taskQueue: 'test-otel',
            workflowId: uuid4(),
          });
          const req = await Promise.race([
            capturedRequest,
            await new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
          ]);
          t.truthy(req);
          t.is(req?.url, '/v1/metrics');
          t.is(req?.headers['x-test-header'], 'test-value');
        });
      } finally {
        await localEnv.teardown();
      }
    }, resolveCapturedRequest);
  } finally {
    // Cleanup the runtime so that it doesn't interfere with other tests
    await Runtime._instance?.shutdown();
  }
});

if (RUN_INTEGRATION_TESTS) {
  test.serial('Otel interceptor spans are connected and complete', async (t) => {
    Runtime.install({});
    try {
      const spans = Array<opentelemetry.tracing.ReadableSpan>();

      const staticResource = opentelemetry.resources.resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'ts-test-otel-worker',
      });
      const traceExporter: opentelemetry.tracing.SpanExporter = {
        export(spans_, resultCallback) {
          spans.push(...spans_);
          resultCallback({ code: ExportResultCode.SUCCESS });
        },
        async shutdown() {
          // Nothing to shutdown
        },
      };
      const otel = new opentelemetry.NodeSDK({
        resource: staticResource,
        traceExporter,
      });
      await otel.start();

      const sinks: InjectedSinks<OpenTelemetrySinks> = {
        exporter: makeWorkflowExporter(traceExporter, staticResource),
      };

      const connection = await Connection.connect();

      const worker = await Worker.create({
        workflowsPath: require.resolve('./workflows'),
        activities,
        taskQueue: 'test-otel',
        interceptors: {
          workflowModules: [require.resolve('./workflows/otel-interceptors')],
          activity: [
            (ctx) => ({
              inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
              outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
            }),
            () => ({ inbound: new ConnectionInjectorInterceptor(connection) }),
          ],
        },
        sinks,
      });

      const client = new WorkflowClient({
        interceptors: [new OpenTelemetryWorkflowClientInterceptor()],
      });
      await worker.runUntil(client.execute(workflows.smorgasbord, { taskQueue: 'test-otel', workflowId: uuid4() }));
      await otel.shutdown();
      const originalSpan = spans.find(({ name }) => name === `${SpanName.WORKFLOW_START}${SPAN_DELIMITER}smorgasbord`);
      t.true(originalSpan !== undefined);
      t.log(
        spans.map((span) => ({
          name: span.name,
          parentSpanContext: span.parentSpanContext,
          spanId: span.spanContext().spanId,
        }))
      );

      const firstExecuteSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.WORKFLOW_EXECUTE}${SPAN_DELIMITER}smorgasbord` &&
          parentSpanContext === originalSpan?.spanContext()
      );
      t.true(firstExecuteSpan !== undefined);
      t.true(firstExecuteSpan!.status.code === SpanStatusCode.OK);

      const continueAsNewSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.CONTINUE_AS_NEW}${SPAN_DELIMITER}smorgasbord` &&
          parentSpanContext === firstExecuteSpan?.spanContext()
      );
      t.true(continueAsNewSpan !== undefined);
      t.true(continueAsNewSpan!.status.code === SpanStatusCode.OK);

      const parentExecuteSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.WORKFLOW_EXECUTE}${SPAN_DELIMITER}smorgasbord` &&
          parentSpanContext === continueAsNewSpan?.spanContext()
      );
      t.true(parentExecuteSpan !== undefined);
      const firstActivityStartSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.ACTIVITY_START}${SPAN_DELIMITER}fakeProgress` &&
          parentSpanContext === parentExecuteSpan?.spanContext()
      );
      t.true(firstActivityStartSpan !== undefined);

      const firstActivityExecuteSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.ACTIVITY_EXECUTE}${SPAN_DELIMITER}fakeProgress` &&
          parentSpanContext === firstActivityStartSpan?.spanContext()
      );
      t.true(firstActivityExecuteSpan !== undefined);

      const secondActivityStartSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.ACTIVITY_START}${SPAN_DELIMITER}queryOwnWf` &&
          parentSpanContext === parentExecuteSpan?.spanContext()
      );
      t.true(secondActivityStartSpan !== undefined);

      const secondActivityExecuteSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.ACTIVITY_EXECUTE}${SPAN_DELIMITER}queryOwnWf` &&
          parentSpanContext === secondActivityStartSpan?.spanContext()
      );
      t.true(secondActivityExecuteSpan !== undefined);

      const childWorkflowStartSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.CHILD_WORKFLOW_START}${SPAN_DELIMITER}signalTarget` &&
          parentSpanContext === parentExecuteSpan?.spanContext()
      );
      t.true(childWorkflowStartSpan !== undefined);

      const childWorkflowExecuteSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.WORKFLOW_EXECUTE}${SPAN_DELIMITER}signalTarget` &&
          parentSpanContext === childWorkflowStartSpan?.spanContext()
      );
      t.true(childWorkflowExecuteSpan !== undefined);

      const signalChildWithUnblockSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.WORKFLOW_SIGNAL}${SPAN_DELIMITER}unblock` &&
          parentSpanContext === parentExecuteSpan?.spanContext()
      );
      t.true(signalChildWithUnblockSpan !== undefined);

      const localActivityStartSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.ACTIVITY_START}${SPAN_DELIMITER}echo` &&
          parentSpanContext === parentExecuteSpan?.spanContext()
      );
      t.true(localActivityStartSpan !== undefined);

      const localActivityExecuteSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.ACTIVITY_EXECUTE}${SPAN_DELIMITER}echo` &&
          parentSpanContext === localActivityStartSpan?.spanContext()
      );
      t.true(localActivityExecuteSpan !== undefined);

      const activityStartedSignalSpan = spans.find(
        ({ name, parentSpanContext }) =>
          name === `${SpanName.WORKFLOW_SIGNAL}${SPAN_DELIMITER}activityStarted` &&
          parentSpanContext === firstActivityExecuteSpan?.spanContext()
      );
      t.true(activityStartedSignalSpan !== undefined);

      t.deepEqual(new Set(spans.map((span) => span.spanContext().traceId)).size, 1);
    } finally {
      // Cleanup the runtime so that it doesn't interfere with other tests
      await Runtime._instance?.shutdown();
    }
  });

  // FIXME: This tests take ~9 seconds to complete on my local machine, even
  //        more in CI, and yet, it doesn't really do any assertion by itself.
  //        To be revisited at a later time.
  test.skip('Otel spans connected', async (t) => {
    const logger = new DefaultLogger('DEBUG');
    Runtime.install({
      logger,
    });
    try {
      const oTelUrl = 'http://127.0.0.1:4317';
      const exporter = new OTLPTraceExporter({ url: oTelUrl });
      const staticResource = opentelemetry.resources.resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'ts-test-otel-worker',
      });
      const otel = new opentelemetry.NodeSDK({
        resource: staticResource,
        traceExporter: exporter,
      });
      await otel.start();

      const sinks: InjectedSinks<OpenTelemetrySinks> = {
        exporter: makeWorkflowExporter(exporter, staticResource),
      };
      const worker = await Worker.create({
        workflowsPath: require.resolve('./workflows'),
        activities,
        enableSDKTracing: true,
        taskQueue: 'test-otel',
        interceptors: {
          workflowModules: [require.resolve('./workflows/otel-interceptors')],
          activity: [(ctx) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(ctx) })],
        },
        sinks,
      });

      const client = new WorkflowClient({
        interceptors: [new OpenTelemetryWorkflowClientInterceptor()],
      });
      await worker.runUntil(client.execute(workflows.smorgasbord, { taskQueue: 'test-otel', workflowId: uuid4() }));
      // Allow some time to ensure spans are flushed out to collector
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      t.pass();
    } finally {
      // Cleanup the runtime so that it doesn't interfere with other tests
      await Runtime._instance?.shutdown();
    }
  });

  test('Otel workflow module does not patch node window object', (t) => {
    // Importing the otel workflow modules above should patch globalThis
    t.falsy((globalThis as any).window);
  });

  test('instrumentation: Error status includes message and records exception', async (t) => {
    const memoryExporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoryExporter)] });
    provider.register();
    const tracer = provider.getTracer('test-error-tracer');

    const errorMessage = 'Test error message';

    await t.throwsAsync(
      instrument({
        tracer,
        spanName: 'test-error-span',
        fn: async () => {
          throw new Error(errorMessage);
        },
      }),
      { message: errorMessage }
    );

    const spans = memoryExporter.getFinishedSpans();
    t.is(spans.length, 1);

    const span = spans[0];

    t.is(span.status.code, SpanStatusCode.ERROR);

    t.is(span.status.message, errorMessage);

    const exceptionEvents = span.events.filter((event) => event.name === 'exception');
    t.is(exceptionEvents.length, 1);
  });
}
