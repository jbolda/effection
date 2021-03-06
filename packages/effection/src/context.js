import { ControlFunction, HaltError } from './control';
import { contextOf } from './resource';

let ids = 1;

export class ExecutionContext {
  get isUnstarted() { return this.state === 'unstarted'; }
  get isRunning() { return this.state === 'running'; }
  get isWaiting() { return this.state === 'waiting'; }
  get isCompleted() { return this.state === 'completed'; }
  get isErrored() { return this.state === 'errored'; }
  get isHalted() { return this.state === 'halted'; }

  get isBlocking() { return this.isRunning || this.isWaiting || this.isUnstarted; }

  constructor({ isRequired = false, blockOnReturnedContext = false } = {}) {
    this.id = ids++;
    this.isRequired = isRequired;
    this.blockOnReturnedContext = blockOnReturnedContext;
    this.children = new Set();
    this.exitHooks = new Set();
    this.state = 'unstarted';
    this.resume = this.resume.bind(this);
    this.fail = this.fail.bind(this);
    this.spawn = this.spawn.bind(this);
    this.fork = this.fork.bind(this);
    this.ensure = this.ensure.bind(this);
  }

  get promise() {
    this._promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.finalizePromise();
    return this._promise;
  }

  finalizePromise() {
    if(this.isCompleted && this.resolve) {
      this.resolve(this.result);
    } else if(this.isErrored && this.reject) {
      this.reject(this.result);
    } else if(this.isHalted && this.reject) {
      this.reject(new HaltError(this.result));
    }
  }

  then(...args) {
    return this.promise.then(...args);
  }

  catch(...args) {
    return this.promise.catch(...args);
  }

  finally(...args) {
    return this.promise.finally(...args);
  }

  get root() {
    if (!this.parent) {
      return this;
    } else {
      return this.parent.root;
    }
  }

  spawn(operation) {
    let child = new ExecutionContext({ isRequired: false });
    this.link(child);
    child.enter(operation);
    return child;
  }

  fork(operation) {
    let child = new ExecutionContext({ isRequired: true });
    this.link(child);
    child.enter(operation);
    return child;
  }

  ensure(hook) {
    let run = hook.bind(null, this);
    if (this.isBlocking) {
      this.exitHooks.add(run);
      return () => this.exitHooks.delete(run);
    } else {
      hook();
      return x => x;
    }
  }

  enter(operation) {
    if (this.isUnstarted) {
      let controller = this.createController(operation);
      this.operation = operation;
      this.state = 'running';

      let { resume, fail, ensure, spawn, fork } = this;
      controller.call({ resume, fail, ensure, spawn, fork, context: this });
    } else {
      throw new Error(`
Tried to call #enter() on a Context that has already been finalized. This
should never happen and so is almost assuredly a bug in effection. All of
its users would be in your eternal debt were you to please take the time to
report this issue here:
https://github.com/thefrontside/effection.js/issues/new

Thanks!`);
    }
  }

  halt(reason) {
    if (this.isBlocking) {
      this.finalize('halted', reason);
    }
  }

  resume(value) {
    if(this.isBlocking) {
      if (this.isRunning) {
        this.result = value;
        if(contextOf(value)) {
          this.link(contextOf(value));
        }
      }
      if(Array.from(this.children).some((c) => (c === value) ? this.blockOnReturnedContext : c.isRequired)) {
        this.state = 'waiting';
      } else {
        this.finalize('completed', value);
      }
    }
  }

  fail(error) {
    if(this.isBlocking) {
      this.finalize('errored', error);
    }
  }

  finalize(state, result) {
    if(this.isBlocking) {
      this.state = state;
      this.result = result || this.result;

      for (let child of Array.from(this.children).reverse()) {
        if(this.blockOnReturnedContext || contextOf(this.result) !== child) {
          child.halt(result);
        }
      }

      for (let hook of Array.from(this.exitHooks).reverse()) {
        try {
          hook();
        } catch(e) {
          /* eslint-disable no-console */
          console.error(`
CRITICAL ERROR: an exception was thrown in an exit handler, this might put
Effection into an unknown state, and you should avoid this ever happening.
Original error:`);
          console.error(e);
          /* eslint-enable no-console */
        }
      }

      if (this.parent) {
        this.parent.trapExit(this);
      }

      this.finalizePromise();
    }
  }

  trapExit(child) {
    this.unlink(child);

    if(child.isCompleted && contextOf(child.result)) {
      this.link(contextOf(child.result));
    }

    if(child.isErrored) {
      this.fail(child.result);
    } else if (this.isWaiting && Array.from(this.children).every((c) => !c.isRequired)) {
      this.finalize('completed');
    }
  }

  link(child) {
    if(this.id === child.id) {
      throw new Error('cannot link context to itself');
    }

    if(!this.isBlocking) {
      child.halt();
    }

    if(child.parent) {
      child.parent.unlink(child);
    }
    if(child.isBlocking) {
      child.parent = this;
      this.children.add(child);
    } else {
      this.trapExit(child);
    }
  }

  unlink(child) {
    child.parent = null;
    this.children.delete(child);
  }

  createController(operation) {
    let controller = ControlFunction.for(operation);
    if (!controller) {
      throw new Error(`cannot find controller for ${operation}`);
    }
    return controller;
  }

  toString(indent = '') {
    let name = this.operation ? this.operation.name || '' : '';
    let children = Array.from(this.children).map(child => `${child.toString(indent + '  ')}`);
    return [`${indent}-> [${this.id}](${name}): ${this.state}`, ...children].join("\n");
  }
}
