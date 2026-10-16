import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ACCOUNT_HOST } from './account-rpc.mjs';

export class AccountService extends TypertRemoteService {
  static inject = ['typert'];
  constructor(ctx, { account, connections, localStatus, updates } = {}) {
    super(ctx, 'eCometAccount', { namespace: 'eCometAccount' });
    this.account = account;
    this.connections = connections;
    this.localStatus = localStatus;
    this.updates = updates;
    ctx.effect(() => ctx.typert.register(ACCOUNT_HOST));
  }
  async getStatus() {
    const local = this.connections && this.localStatus ? await this.localStatus() : undefined;
    // Recovery may finish during the bridge read; snapshot all synchronous state afterward.
    const connections = this.connections ? { ...this.connections, ...(this.localStatus ? { local } : {}) } : undefined;
    return { ...this.account.getStatus(), ...(connections ? { connections } : {}), ...(this.updates ? { updates: this.updates.getStatus() } : {}) };
  }
  accountAction(execute) { return this.updates ? this.updates.runTool(execute) : execute(); }
  startLogin() {
    // Return the browser URL promptly, but block updates until OAuth has settled.
    let resolve, reject;
    const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
    Promise.resolve(this.accountAction(async () => {
      resolve(await this.account.startLogin());
      await this.account.waitForLogin?.();
    })).catch(reject);
    return ready;
  }
  cancelLogin() { return this.accountAction(() => this.account.cancelLogin()); }
  disconnect() { return this.accountAction(() => this.account.disconnect()); }
  installUpdate() { return this.updates.installUpdate(); }
  checkUpdates() { return this.updates.checkUpdates(); }
}
