// Output storage that cannot be resolved; use cases test for it with instanceof (refactor spec §6.3).
export class StorageUnavailableError extends Error {
    constructor(store, reason) {
        super('Local output storage is unavailable.');
        this.name = 'StorageUnavailableError';
        this.code = 'LOCAL_STORAGE_UNAVAILABLE';
        this.stage = 'storage';
        this.retryable = false;
        this.store = store;
        this.reason = reason;
    }
}
