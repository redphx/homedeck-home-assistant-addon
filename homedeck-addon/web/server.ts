import Bonjour from "bonjour-service";
import express from "express";
// import ViteExpress from "vite-express";
import url from 'url';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import http from 'http';
import path from "path";
import { fileURLToPath } from 'url';
import compression from 'compression';


type MdnsDevice = {
    name: string;
    address: string;
    port: number;
    properties: {
        version: string;
        api_version: string;
    };
}


class RemoteWebSocketManager {
    // Map to keep a persistent remote connection per host
    remoteConnections: Map<String, WebSocket> = new Map();

    // Map host -> Set of connected clients
    clientGroups: Map<String, Set<WebSocket>> = new Map();

    constructor() {}

    private registerClient(client: WebSocket, host: string) {
        const group = this.clientGroups.get(host);
        group?.add(client);
    }

    open(client: WebSocket, host: string, apiVersion: string): WebSocket {
        let remoteWs = this.remoteConnections.get(host);
        if (remoteWs && remoteWs.readyState !== WebSocket.OPEN) {
            this.registerClient(client, host);
            return remoteWs;
        }

        remoteWs = new WebSocket(`ws://${host}/v${apiVersion}/ws`);
        remoteWs.on('open', () => {
            console.log(`[${host}] Remote connected`);
        });

        remoteWs.on('close', () => {
            console.log(`[${host}] Remote disconnected`);
            this.remoteConnections.delete(host);
        });

        remoteWs.on('error', (err) => {
            console.error(`[${host}] Remote error`, err.message);
        });

        // Broadcast to all local clients for this host
        remoteWs.on('message', (msg, isBinary) => {
            const clients = this.clientGroups.get(host) || new Set();
            for (const client of clients) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(msg, { binary: isBinary });
                }
            }
        });

        this.remoteConnections.set(host, remoteWs);
        const group = new Set<WebSocket>();
        group.add(client);
        this.clientGroups.set(host, group);

        return remoteWs;
    }

    close(client: WebSocket, host: string) {
        console.log(`Client disconnected from host ${host}`);
        const group = this.clientGroups.get(host);
        group?.delete(client);

        // If no clients left for this host, close remote
        if (!group || group.size === 0) {
            console.log(`No clients left for ${host}, closing remote`);

            let remoteWs = this.remoteConnections.get(host);
            remoteWs?.close();

            this.clientGroups.delete(host);
        }
    }
}

function isValidHost(str: string) {
    const regex = /^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;
    if (!regex.test(str)) {
        return false;
    }

    const [ip, port] = str.split(':');
    const octets = ip.split('.').map(Number);

    // Check that each octet is between 0-255
    const validIp = octets.every(n => n >= 0 && n <= 255);
    const validPort = Number(port) >= 1 && Number(port) <= 65535;

    return validIp && validPort;
};

function scanMdns(): Promise<{ name: string; address: string; port: number }[]> {
    return new Promise(resolve => {
        const bonjour = new Bonjour();
        const services: MdnsDevice[] = [];

        /*
        // Test
        services.push({
            name: 'Test',
            address: '127.0.0.1',
            port: 123,
            properties: {
                version: '1.0',
                api_version: '1',
            },
        });
        */

        const browser = bonjour.find({ type: 'homedeck' });
        browser.on('up', async service => {
            const addresses = service.addresses;
            // Test connection to addresses
            for (const addr of addresses) {
                const url = `http://${addr}:${service.port}/v${service.txt.api_version}/status`;
                try {
                    const response = await fetch(url, {
                        method: 'HEAD',
                        signal: AbortSignal.timeout(500),
                    });

                    if (response.status === 200) {
                        services.push({
                            name: service.name,
                            address: addr,
                            port: service.port,
                            properties: service.txt,
                        });
                        break;
                    }
                } catch (e) {
                    console.log(e);
                }
            }
        });

        // Stop scanning after 3 seconds and resolve
        setTimeout(() => {
            browser.stop();
            bonjour.destroy();
            resolve(services);
        }, 5000);
    });
}

const app = express();
app.use(compression());

const __dirname = path.dirname(fileURLToPath(import.meta.url))

app.use(express.json());
// Serve Vite built files
app.use(express.static(path.join(__dirname, 'dist')))

app.get('/devices', async (_, res) => {
    const services = await scanMdns();
    res.send({ data: services });
});

app.get('/proxy/:host/v:api_version/:endpoint', async (req, res) => {
    const host = req.params.host;
    const apiVersion = req.params.api_version;
    const endpoint = req.params.endpoint;

    if (!isValidHost(host)) {
        res.json({ error: `Invalid host: ${host}` });
        return;
    }

    if (!['configuration', 'schema'].includes(endpoint)) {
        res.send({ error: `Invalid endpoint: ${endpoint}` });
        return;
    }

    const url = `http://${host}/v${apiVersion}/${endpoint}`;
    try {
        if (endpoint === 'schema') {
            const body = await (await fetch(url)).text();
            res.send(body);
        } else {
            const body = await (await fetch(url)).json();
            res.json(body);
        }
    } catch (e) {
        console.log(e);
        res.json({ error: `Unreachable: ${url}` });
    }
});

app.post('/proxy/:host/v:api_version/:endpoint', async (req, res) => {
    const host = req.params.host;
    const apiVersion = req.params.api_version;
    const endpoint = req.params.endpoint;
    const postData = req.body || {};

    if (!isValidHost(host)) {
        res.json({ error: `Invalid host: ${host}` });
        return;
    }

    if (!['configuration', 'start', 'stop'].includes(endpoint)) {
        res.json({ error: `Invalid endpoint: ${endpoint}` });
        return;
    }

    const url = `http://${host}/v${apiVersion}/${endpoint}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(postData),
        });

        const responseData = await response.json();
        res.json(responseData);
    } catch (e) {
        console.log(e);
        res.json({ error: `Unreachable: ${url}` });
    }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const remoteWsManager = new RemoteWebSocketManager();

server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url!);
    const match = pathname!.match(/^\/proxy\/(.+)\/v(.+)\/ws$/);
    console.log(pathname);
    if (!match) {
        socket.destroy();
        return;
    }

    const host = match[1];
    const apiVersion = match[2];

    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request, host, apiVersion));
});

// Handle client connection
wss.on('connection', (client: WebSocket, req: http.IncomingMessage, host: string, apiVersion: string) => {
    console.log(`New client connected for host ${host}`);

    // Connect to remote if not already
    const remoteWs = remoteWsManager.open(client, host, apiVersion);

    // Relay client messages to remote
    client.on('message', (msg) => {
        if (remoteWs.readyState === WebSocket.OPEN) {
            remoteWs.send(msg);
        }
    });

    client.on('close', () => {
        remoteWsManager.close(client, host);
    });

    client.on('error', (err) => {
        console.error(`Client error [${host}]`, err.message);
    });
});

server.listen(4663, () => console.log('Server is listening...'));

/*
ViteExpress.config({
    inlineViteConfig: {
        server: {
            hmr: {
                port: 46630,  // Use a different port to avoid conflict
                protocol: 'ws',
            },
        },
    },
});
ViteExpress.bind(app, server);
*/
