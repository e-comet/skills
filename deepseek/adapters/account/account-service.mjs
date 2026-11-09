import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ACCOUNT_HOST } from './account-rpc.mjs';
// The root always passes the account; a call without one fails, as reading through it always did.
const present = (value) => {
    if (value === undefined)
        throw new TypeError('The e-Comet account service is missing a dependency.');
    return value;
};
export class AccountService extends TypertRemoteService {
    static inject = ['typert'];
    constructor(ctx, { account, connections, localStatus } = {}) {
        super(ctx, 'eCometAccount', { namespace: 'eCometAccount' });
        this.account = account;
        this.connections = connections;
        this.localStatus = localStatus;
        // The fixed gateway name assumes one live plugin instance: see "Native DeepSeek registrations assume one live
        // plugin instance" in docs/architecture/residuals/deepseek.md.
        ctx.effect(() => ctx.typert.register(ACCOUNT_HOST));
    }
    async getStatus() {
        const local = this.connections && this.localStatus ? await this.localStatus() : undefined;
        // Recovery may finish during the bridge read; snapshot all synchronous state afterward.
        const connections = this.connections ? { ...this.connections, ...(this.localStatus ? { local } : {}) } : undefined;
        return {
            ...present(this.account).getStatus(),
            ...(connections ? { connections } : {}),
        };
    }
    // The account resolves as soon as the browser URL exists or the attempt ends.
    startLogin() {
        return present(this.account).startLogin();
    }
    cancelLogin() {
        return present(this.account).cancelLogin();
    }
    disconnect() {
        return present(this.account).disconnect();
    }
}
