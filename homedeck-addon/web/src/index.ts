import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { configureMonacoYaml } from 'monaco-yaml'
import YamlWorker from './lib/workaround-yaml.worker?worker'
import './style.styl'

type CreateElementOptions = {
    [index: string]: any;
    _on?: {
        [ key: string ]: (e: Event) => void;
    };
    _dataset?: {
        [ key: string ]: string | number | boolean;
    };
};

type Device = {
    address: string;
    name: string;
    port: number;
    properties: {
        api_version: string;
        version: string;
    };

    baseProxyPath: string;
};

type WsMessage = {
    type: 'status';
    payload: {
        status: 'running' | 'stopped';
    };
} | {
    type: 'logs';
    payload: {
        message: string;
        timestamp: number;
    };
};

const CE = function createElement<T extends keyof HTMLElementTagNameMap>(elmName: T, props?: CreateElementOptions | false, ..._: any): HTMLElementTagNameMap[T] {
    let $elm;
    const hasNs = props && 'xmlns' in props;

    if (hasNs) {
        $elm = document.createElementNS(props.xmlns, elmName as string);
        delete props.xmlns;
    } else {
        $elm = document.createElement(elmName as string);
    }

    if (props) {
        if (props._on) {
            for (const name in props._on) {
                $elm.addEventListener(name, props._on[name]);
            }
            delete props._on;
        }

        if (props._dataset) {
            for (const name in props._dataset) {
                $elm.dataset[name] = props._dataset[name] as string;
            }
            delete props._dataset;
        }

        for (const key in props) {
            if ($elm.hasOwnProperty(key)) {
                continue;
            }

            const value = props[key];
            if (hasNs) {
                $elm.setAttributeNS(null, key, value);
            } else {
                $elm.setAttribute(key, value);
            }
        }
    }

    for (let i = 2, size = arguments.length; i < size; i++) {
        const arg = arguments[i];

        if (arg !== null && arg !== false && typeof arg !== 'undefined') {
            $elm.append(arg);
        }
    }

    return $elm as HTMLElementTagNameMap[T];
}

window.MonacoEnvironment = {
    getWorker(_, label) {
    switch (label) {
        case 'editorWorkerService':
            return new EditorWorker();
        case 'yaml':
            return new YamlWorker();
        default:
            throw new Error(`Unknown label ${label}`);
    }
    }
}

let DEVICES: Device[] = [];
let EDITOR: monaco.editor.IStandaloneCodeEditor | null = null;
let WEB_SOCKET: WebSocket | null = null;

const $problems = document.querySelector('#problems')!;
const $problemsList = $problems.querySelector<HTMLUListElement>('ul')!;

const $infoDevice = document.querySelector<HTMLElement>('.info-device')!;
const $infoVersion = document.querySelector<HTMLElement>('.info-version')!;
const $infoStatus = document.querySelector<HTMLElement>('.info-status')!;
const $startBtn = document.querySelector<HTMLButtonElement>('.btn-start')!;
const $stopBtn = document.querySelector<HTMLButtonElement>('.btn-stop')!;
const $saveBtn = document.querySelector<HTMLButtonElement>('.btn-save')!;

const $devices = document.querySelector<HTMLSelectElement>('.devices')!;

class LogsPanel {
    private MAX_LOGS = 50;

    private $list: HTMLElement;

    constructor($root: HTMLElement) {
        this.$list = $root.querySelector('ul')!;
    }

    clear() {
        emptyChildElements(this.$list);
    }

    addLog(log: Extract<WsMessage, { type: 'logs' }>['payload']) {
        const $list = this.$list;
        // Ensure number of logs
        while ($list.childElementCount > this.MAX_LOGS - 1) {
            // Remove first
            $list.firstElementChild?.remove();
        }

        const date = new Date(log.timestamp * 1000);
        const hours = String(date.getHours()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        // Auto scroll
        const autoScroll = $list.scrollHeight - $list.scrollTop === $list.clientHeight;

        // Append log
        const $message = CE('li', false,
            CE('span', false, `[${hours}:${seconds}] `),
            log.message,
        );
        $list.appendChild($message);

        if (autoScroll) {
            $list.scrollTo({
                top: $list.scrollHeight,
                behavior: 'instant',
            });
        }
    }
}

const logsPanel = new LogsPanel(document.querySelector('#logs')!);

function emptyChildElements($parent: HTMLElement) {
    while ($parent.lastChild) {
        $parent.lastChild.remove();
    }
}

function resetEditor() {
    $saveBtn.disabled = true;
    $problems.classList.toggle('gone', true);

    // Clear problems
    updateProblemsState(false);
    emptyChildElements($problemsList);
    // Clear Logs panel
    logsPanel.clear();

    // Reset monaco editor
    if (EDITOR) {
        EDITOR.setValue('');
        EDITOR.updateOptions({
            readOnly: true,
        });
    }
}

function updateState(status: 'running' | 'stopped' | 'unavailable' ) {
    const isUnavailable = status === 'unavailable';
    const isRunning = status === 'running';

    $infoStatus.textContent = {
        'running': 'Running',
        'stopped': 'Stopped',
        'unavailable': 'Unavailable',
    }[status];
    $infoStatus.dataset.status = status;

    if (isUnavailable) {
        $startBtn.disabled = true;
        $stopBtn.disabled = true;
    } else {
        $startBtn.disabled = isRunning;
        $stopBtn.disabled = !isRunning;
    }
}

function updateProblemsState(hasProblems: boolean) {
    $saveBtn.disabled = hasProblems;
    $problems.classList.toggle('gone', !hasProblems);
}

function setupEditor() {
    $startBtn.addEventListener('click', e => {
        e.preventDefault();
        const device = DEVICES[$devices.selectedIndex];
        if (!device) {
            return;
        }

        fetch(`${device.baseProxyPath}/start`, { method: 'POST' });
    });

    $stopBtn.addEventListener('click', e => {
        e.preventDefault();
        const device = DEVICES[$devices.selectedIndex];
        if (!device) {
            return;
        }

        if (confirm('Do you want to stop running HomeDeck on this device?')) {
            fetch(`${device.baseProxyPath}/stop`, { method: 'POST' });
        }
    });

    const monacoYaml = configureMonacoYaml(monaco, {
        enableSchemaRequest: true,
        schemas: [],
    });

    EDITOR = monaco.editor.create(document.getElementById('editor')!!, {
        automaticLayout: true,
        theme: 'vs-dark',
        quickSuggestions: {
            other: true,
            comments: false,
            strings: true,
        },
        model: monaco.editor.createModel('', 'yaml', monaco.Uri.parse('file:///homedeck.yaml')),
    });

    monaco.editor.onDidChangeMarkers(uris => {
        // Clear current problems
        emptyChildElements($problemsList);

        let hasProblems = false;
        const $fragment = document.createDocumentFragment();
        uris.forEach(uri => {
            const markers = monaco.editor.getModelMarkers({ owner: undefined });
            // console.log('Updated markers for:', uri.toString(), markers);

            for (const marker of markers) {
                if (marker.severity === monaco.MarkerSeverity.Hint) {
                    continue;
                }

                const editorInstance = monaco.editor.getEditors().find(ed => ed.getModel()?.uri.toString() === uri.toString());
                if (!editorInstance) {
                    continue;
                }

                hasProblems = true;
                const $problem = CE('li', {
                    _on: {
                        'click': e => {
                            e.preventDefault();
                            editorInstance.setPosition({
                                lineNumber: marker.startLineNumber,
                                column: marker.startColumn,
                            });
                            editorInstance.focus();
                        },
                    },
                }, marker.message);

                $fragment.appendChild($problem);
            }
        });

        updateProblemsState(hasProblems);
        if (hasProblems) {
            $problemsList.appendChild($fragment);
        }
    });

    $devices.addEventListener('change', async _ => {
        resetEditor();

        const device = DEVICES[$devices.selectedIndex];
        if (!device) {
            return;
        }

        // Info panel
        $infoDevice.textContent = `${device.name} (${device.address}:${device.port})`;
        $infoVersion.textContent = `${device.properties.version} (API v${device.properties.api_version})`;

        const schemas = [{
            fileMatch: ['**/homedeck.*'],
            uri: `${device.baseProxyPath}/schema`,
        }];

        monacoYaml.update({ schemas });

        let response;
        try {
            response = await (await fetch(`${device.baseProxyPath}/configuration`)).json();
        } catch (e) {
            updateState('unavailable');
            return;
        }
        EDITOR!.setValue(response['data']['content']);
        EDITOR!.updateOptions({
            readOnly: false,
        });

        // WebSocket
        WEB_SOCKET?.close();
        WEB_SOCKET = new WebSocket(`ws://${window.location.host}${window.location.pathname}proxy/${device.address}:${device.port}/v${device.properties.api_version}/ws`);
        WEB_SOCKET.onopen = () => {
            console.log('ws connected');
        };
        WEB_SOCKET.onmessage = event => {
            try {
                const message = JSON.parse(event.data) as WsMessage;
                switch (message.type) {
                    case 'status':
                        updateState(message.payload.status);
                        break;
                    case 'logs':
                        logsPanel.addLog(message.payload);
                        break;
                }
            } catch (e) {
                console.log(e);
            }
        };

    });

    $saveBtn.addEventListener('click', e => {
        e.preventDefault();
        const content = EDITOR!.getValue();

        const device = DEVICES[$devices.selectedIndex];
        const url = `${device.baseProxyPath}/configuration`;
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        });
    });

    for (const device of DEVICES) {
        device.baseProxyPath = `${window.location.pathname}proxy/${device.address}:${device.port}/v${device.properties.api_version}`;

        const name = `${device.name} (${device.address}:${device.port})`;
        const $option = CE('option', false, name);
        $devices?.appendChild($option);
    }

    $devices.dispatchEvent(new Event('change'));
}

updateState('stopped');
resetEditor();

// Get devices
fetch(`${window.location.pathname}devices`)
    .then(resp => resp.json())
    .then(json => {
        console.log(json.data);
        const $message = document.querySelector<HTMLElement>('.message')!;
        const $content = document.querySelector<HTMLElement>('.content')!;
        if (json.data.length) {
            DEVICES = json.data;
            setupEditor();

            $message.classList.add('gone');
            $content.classList.remove('gone');
        } else {
            emptyChildElements($message);
            $message.appendChild(CE('span', false,
                '🚫 No devices found. Refresh the page to try again.',
                CE('button', {
                    class: 'btn-reload',
                    _on: {
                        click: () => window.location.reload(),
                    }
                }, 'Refresh'),
            ));
        }
    });
