declare module 'unix-dgram' {
  import { EventEmitter } from 'events';

  interface SocketOptions {
    type: 'unix_dgram';
    callback?: (msg: Buffer, rinfo: { address: string; family: string; port: number }) => void;
  }

  class Socket extends EventEmitter {
    constructor(options: SocketOptions);
    bind(path: string): void;
    send(
      buf: Buffer,
      offset: number,
      length: number,
      path: string,
      callback?: (err: Error | null) => void
    ): void;
    close(): void;
  }

  function createSocket(type: 'unix_dgram', callback?: (msg: Buffer, rinfo: { address: string; family: string; port: number }) => void): Socket;

  export { createSocket, Socket };
}

