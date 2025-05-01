import express from "express";
// import ViteExpress from "vite-express";
import url from 'url';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import http from 'http';
import path from "path";
import { fileURLToPath } from 'url';
import compression from 'compression';

import os from "os";
import mdns from "multicast-dns";
import type { StringAnswer, SrvAnswer, TxtAnswer } from "dns-packet";


type MdnsDevice = {
    name?: string;
    host?: string;
    address?: string;
    port?: number;
    properties?: {
        version: string;
        api_version: string;
    };
}

const MDNS_SERVICES: Record<string, MdnsDevice> = {};


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

function scanMdns() {
    const interfaces = os.networkInterfaces();
    const timeoutMs = 5000;
    const mdnsInstances: any[] = [];

    Object.entries(interfaces).forEach(([name, addresses]: [any, any]) => {
        addresses.filter(addr => addr.family === 'IPv4' && !addr.internal).forEach(addr => {
            const mdnsInstance = mdns({ bind: '0.0.0.0', interface: addr.address });
            mdnsInstances.push(mdnsInstance);

            mdnsInstance.on('response', response => {
                response.answers.filter(answer => answer.name === '_homedeck._tcp.local' && answer.type === 'PTR')
                    .forEach(answer => {
                        const host = (answer as StringAnswer).data;
                        if (!MDNS_SERVICES[host]) {
                            MDNS_SERVICES[host] = {};
                        }
                        MDNS_SERVICES[host].name = host;
                    });

                response.additionals.forEach(answer => {
                    switch (answer.type) {
                        case 'SRV':
                            if (!(answer.name in MDNS_SERVICES)) {
                                return;
                            }

                            const { target, port } = (answer as SrvAnswer).data;
                            MDNS_SERVICES[answer.name].host = target;
                            MDNS_SERVICES[answer.name].port = port;
                            break;
                        case 'A':
                            for (const key in MDNS_SERVICES) {
                                if (MDNS_SERVICES[key].host === answer.name) {
                                    MDNS_SERVICES[key].address = (answer as StringAnswer).data;
                                }
                            }
                            break;
                        case 'TXT':
                            if (!(answer.name in MDNS_SERVICES)) {
                                return;
                            }

                            const txtData = answer.data;
                            const txtObject = {};

                            for (const buf of txtData) {
                                const entry = buf.toString(); // e.g., 'path=/api'
                                const [key, value] = entry.split('=');
                                txtObject[key] = value || true; // supports boolean flags
                            };
                            MDNS_SERVICES[answer.name].properties = txtObject as unknown as MdnsDevice['properties'];
                            break;
                    }
                });
            });

            // Send a query for all service types
            setInterval(() => {
                mdnsInstance.query([{
                    name: '_homedeck._tcp.local.',
                    type: 'PTR',
                }]);
            }, 10000);

            console.log(`Scanning on interface ${name} (${addr.address})...`);
        });
    });
}

const app = express();
app.use(compression());

const __dirname = path.dirname(fileURLToPath(import.meta.url))

app.use(express.json());
// Serve Vite built files
app.use(express.static(path.join(__dirname, 'dist')))

app.get('/devices', async (_, res) => {
    const services: MdnsDevice[] = [];

    for (const service of Object.values(MDNS_SERVICES)) {
        const url = `http://${service.address}:${service.port}/v${service.properties?.api_version}/status`;
        try {
            const resp = await fetch(url, {
                method: 'HEAD',
            });

            if (resp.status === 200) {
                services.push(service);
            }
        } catch (e) {}
    };

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

scanMdns();

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
