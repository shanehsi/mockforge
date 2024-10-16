import cors from 'cors';
import express, { Request, Response } from 'express';
import getPort from 'get-port';
import { createServer } from 'node:http';
import querystring from 'query-string';
import { WebSocket, WebSocketServer } from 'ws';
import { serverDebugLog } from '../../logger/node.js';
import { MockForgeEvent } from '../common/event.js';
import { RPCRequestBody, RPCResponse } from './../common/rpc.js';
import { MockForgeStateService } from './service.js';

export interface CreateMockForgeServerOption {
  baseDir: string;
  port?: number;
  static?: string[];
}

interface Client {
  id: string;
  ws: WebSocket;
}

export async function createMockForgeServer(option: CreateMockForgeServerOption): Promise<number> {
  serverDebugLog(`start option ${JSON.stringify(option)}`);
  const serverPort = await getPort({ port: option.port || 50930 });
  return new Promise((resolve, reject) => {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });
    app.use(express.json());
    app.use(cors());
    const mockForgeStateService = new MockForgeStateService(option.baseDir);
    const clients: Client[] = [];
    // 添加一个方法来发送事件给所有客户端
    function broadcastEvent(event: MockForgeEvent) {
      clients.forEach((client) => {
        client.ws.send(JSON.stringify(event));
      });
    }
    if (option.static) {
      option.static.forEach((e) => {
        serverDebugLog(`register static dir` + e);
        app.use(express.static(e));
      });
    }
    app.post('/api/v1/mockforge/rpc', async (req: Request, res: Response) => {
      const requestBody = req.body as RPCRequestBody;
      const { method, args, clientId } = requestBody;
      let response: RPCResponse;
      try {
        const serviceMethod = mockForgeStateService[method as keyof MockForgeStateService] as Function;
        if (typeof serviceMethod !== 'function') {
          throw new Error(`Unknown method: ${method}`);
        }
        const result = await serviceMethod.apply(mockForgeStateService, args);
        response = {
          success: true,
          data: result,
          clientId,
        };
      } catch (error) {
        response = {
          success: false,
          errorMessage: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : '',
          clientId,
        };
      }

      try {
        switch (method as keyof MockForgeStateService) {
          case 'addMockAPI':
          case 'deleteHttpMockAPI':
          case 'deleteHttpMockResponse':
          case 'updateHttpMockAPI':
          case 'addHttpMockResponse': {
            broadcastEvent({
              type: 'http-mock-api-change',
              clientId,
            });
            break;
          }
          case 'toggleHttpApiResponse': {
            broadcastEvent({
              type: 'mock-forge-state-change',
              clientId,
            });
            break;
          }
        }
      } catch (error) {}

      res.json(response);
    });

    app.all('/mocked/*', async (req: Request, res: Response) => {
      const uuid = req.get('mockforge-result-uuid');
      if (!uuid) {
        res.status(404).send('Missing mock result uuid');
        return;
      }
      const result = await mockForgeStateService.getHttpMockResult(uuid);
      if (!result) {
        res.status(404).send('Mock result not found');
        return;
      }
      res.status(result.status).json(result.body);
    });

    wss.on('connection', (ws: WebSocket, req: Request) => {
      const parseResult = querystring.parseUrl(req.url);
      const url = parseResult.url;
      const clientId = String(parseResult.query.clientId);
      if (clientId && url === '/api/v1/mockforge/connect') {
        const client: Client = { id: clientId, ws };
        clients.push(client);
        ws.on('close', () => {
          const index = clients.findIndex((c) => c.id === clientId);
          if (index !== -1) {
            clients.splice(index, 1);
          }
        });
      } else {
        ws.close();
      }
    });

    serverDebugLog(`start listen at ${serverPort}`);
    server.listen(serverPort, () => {
      const address = server.address();
      serverDebugLog(`server address ${JSON.stringify(address)}`);
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
    server.on('error', (error) => {
      reject(error);
    });
  });
}
