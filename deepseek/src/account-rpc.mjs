/** Browser-safe descriptors for the native account API. No model tools expose these methods. */
export const ACCOUNT_REMOTE = {
  package: 'dsh-e-comet-skills',
  descriptors: ['getStatus', 'startLogin', 'cancelLogin', 'disconnect', 'installUpdate', 'checkUpdates'].map(method => ({
    id: `dsh-e-comet-skills#eCometAccount/${method}`,
    service: 'eCometAccount', namespace: 'eCometAccount', method,
    invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
  })),
};
export const ACCOUNT_HOST = {
  package: ACCOUNT_REMOTE.package, face: 'host', schemas: [],
  model: { services: [], events: [], objects: [] }, invocations: ACCOUNT_REMOTE.descriptors,
};
