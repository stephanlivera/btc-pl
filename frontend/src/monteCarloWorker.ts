import { simulateEnsemble, type SimulateConfig } from './monteCarloModel';

interface WorkerRequest {
  requestId: number;
  config: SimulateConfig;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { requestId, config } = event.data;
  try {
    const result = simulateEnsemble(config);
    self.postMessage({ requestId, ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ requestId, ok: false, error: message });
  }
};
