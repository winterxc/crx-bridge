import serializeError from 'serialize-error'
import oneline from 'oneline'
import uuid from 'tiny-uid'

const browser = window.browser || window.chrome

// eslint-disable-next-line no-shadow
const RuntimeContext = {
    Devtools: 'devtools',
    Background: 'background',
    ContentScript: 'content-script',
    Window: 'window'
}

const ENDPOINT_RE = /^((?:background$)|devtools|content-script|window)(?:@(\d+))?$/;
export const parseEndpoint = (endpoint)=>{
    const [, context, tabId] = endpoint.match(ENDPOINT_RE);

    return {
        context: context,
        tabId: +tabId
    }
}

export const isInternalEnpoint=({context:ctx})=>[RuntimeContext.ContentScript, RuntimeContext.Background, RuntimeContext.Devtools].some(internalCtx => internalCtx === ctx)
const hasAPI = (nsps)=>browser[nsps];

const context=
    hasAPI('devtools') ? RuntimeContext.Devtools
    : hasAPI('tabs') ? RuntimeContext.Background
    : hasAPI('extension') ? RuntimeContext.ContentScript
    : (typeof document !== 'undefined') ? RuntimeContext.Window : null;

const runtimeId = uuid()
const openTransactions = new Map()
const onMessageListeners = new Map()
const messageQueue = new Set()
const portMap = new Map()
let port = null

let namespace
let isWindowMessagingAllowed

initIntercoms()

/**
 * Sends a message to some other endpoint, to which only one listener can send response.
 * Returns Promise. Use `then` or `await` to wait for the response.
 * If destination is `window` message will routed using window.postMessage.
 * Which requires a shared namespace to be set between `content-script` and `window`
 * that way they can recognize each other when global window.postMessage happens and there are other
 * extensions using crx-bridge as well
 * @param messageID
 * @param data
 * @param destination
 */
export async function sendMessage(messageID, data, destination){
    const endpoint = typeof destination === 'string' ? parseEndpoint(destination) : destination;
    const errFn = 'Bridge#sendMessage ->';

    if (!endpoint.context) {
        throw new TypeError(`${errFn} Destination must be any one of known destinations`);
    }

    if (context === RuntimeContext.Background) {
        const { context: dest, tabId: destTabId } = endpoint
        if (dest !== 'background' && !destTabId) {
            throw new TypeError(`${errFn} When sending messages from background page, use @tabId syntax to target specific tab`);
        }
    }

    return new Promise((resolve, reject) => {
        const payload = {
            messageID,
            data,
            destination: endpoint,
            messageType: 'message',
            transactionId: uuid(),
            origin: { context, tabId: null },
            hops: [],
            timestamp: Date.now(),
        };

        openTransactions.set(payload.transactionId, { resolve, reject });
        routeMessage(payload);
    })
}

export function onMessage(messageID, callback){
    onMessageListeners.set(messageID, callback)
}

export function setNamespace(nsps){
    namespace = nsps
}

export function allowWindowMessaging(nsps){
    isWindowMessagingAllowed = true
    namespace = nsps
}


function initIntercoms() {
    if (context === null) {
        throw new Error('Unable to detect runtime context i.e crx-bridge can\'t figure out what to do');
    }

    if (context === RuntimeContext.Window || context === RuntimeContext.ContentScript) {
        window.addEventListener('message', handleWindowOnMessage);
    }

    if (context === RuntimeContext.ContentScript && top === window) {
        port = browser.runtime.connect();
        port.onMessage.addListener((message) => {
            routeMessage(message);
        })
    }

    if (context === RuntimeContext.Devtools) {
        const { tabId } = browser.devtools.inspectedWindow;
        const name = `devtools@${tabId}`;

        port = browser.runtime.connect(void 0, { name })

        port.onMessage.addListener((message) => {
            routeMessage(message)
        })

        port.onDisconnect.addListener(() => {
            port = null
        })
    }

    if (context === RuntimeContext.Background) {
        browser.runtime.onConnect.addListener(incomingPort => {
            // when coming from devtools, it's should pre-fabricated with inspected tab as linked tab id
            const portId = incomingPort.name || `content-script@${incomingPort.sender.tab.id}`;
            // literal tab id in case of content script, however tab id of inspected page in case of devtools context
            const { tabId: linkedTabId } = parseEndpoint(portId)

            // in-case the port handshake is from something else
            if (!linkedTabId) {
                return;
            }

            portMap.set(portId, incomingPort)

            messageQueue.forEach((queuedMsg) => {
                if (queuedMsg.resolvedDestination === portId) {
                    incomingPort.postMessage(queuedMsg.message);
                    messageQueue.delete(queuedMsg);
                }
            });

            incomingPort.onDisconnect.addListener(() => {
                portMap.delete(portId);
            })

            incomingPort.onMessage.addListener((message) => {
                if (message?.origin?.context) {
                    // origin tab ID is resolved from the port identifier (also prevent "MITM attacks" of extensions)
                    message.origin.tabId = linkedTabId;

                    routeMessage(message);
                }
            })
        })
    }
}

function routeMessage(message){
    const { origin, destination } = message

    if (message.hops.indexOf(runtimeId) > -1) {
        return
    }

    message.hops.push(runtimeId)

    if (context === RuntimeContext.ContentScript
        && [destination, origin].some(endpoint => endpoint?.context === RuntimeContext.Window)
        && !isWindowMessagingAllowed) {
        return
    }

    // if previous hop removed the destination before forwarding the message, then this itself is the recipient
    if (!destination) {
        return handleInboundMessage(message)
    }

    if (destination.context) {
        if (context === RuntimeContext.Window) {
            return routeMessageThroughWindow(window, message)
        }

        else if (context === RuntimeContext.ContentScript && destination.context === RuntimeContext.Window) {
            message.destination = null
            return routeMessageThroughWindow(window, message)
        }

        else if (context === RuntimeContext.Devtools || context === RuntimeContext.ContentScript) {
            if (destination.context === RuntimeContext.Background) {
                message.destination = null
            }
            // Just hand it over to background page
            return port.postMessage(message)
        }

        else if (context === RuntimeContext.Background) {
            const { context: destName, tabId: destTabId } = destination
            const { tabId: srcTabId } = origin

            // remove the destination in case the message isn't going to `window`; it'll be forwarded to either `content-script` or `devtools`...
            if (destName !== RuntimeContext.Window) {
                message.destination = null
            } else {
                // ...however if it is directed towards window, then patch the destination before handing the message off to the `content-script` in
                // the same tab. since `content-script` itself doesn't know it's own tab id, a destination like `window@144` is meaningless to the
                // `content-script` and it'll crap out as it would think it belongs to some other window and will pass it back to background page
                message.destination.tabId = null
            }

            // As far as background page is concerned, it just needs to know the which `content-script` or `devtools` should it forward to
            const resolvedDestination = `${(destName === 'window' ? 'content-script' : destName)}@${(destTabId || srcTabId)}`
            const destPort = portMap.get(resolvedDestination)

            if (destPort) {
                destPort.postMessage(message);
            } else {
                messageQueue.add({ resolvedDestination, message })
            }
        }
    }
}

async function handleInboundMessage(message) {
    const { transactionId, messageID, messageType } = message

    const handleReply = () => {
        const transactionP = openTransactions.get(transactionId)
        if (transactionP) {
            const { err, data } = message
            if (err) {
                const dehydratedErr = err
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const errCtr = self[dehydratedErr.name];
                const hydratedErr = new (typeof errCtr === 'function' ? errCtr : Error)(dehydratedErr.message)
                for (const prop in dehydratedErr) {
                    hydratedErr[prop] = dehydratedErr[prop]
                }
                transactionP.reject(hydratedErr)
            } else {
                transactionP.resolve(data)
            }
            openTransactions.delete(transactionId)
        }
    }

    const handleNewMessage = async () => {
        let reply
        let err
        let noHandlerFoundError = false

        try {
            const cb = onMessageListeners.get(messageID)
            if (typeof cb === 'function') {
                reply = await cb({
                    sender: message.origin,
                    id: messageID,
                    data: message.data,
                    timestamp: message.timestamp,
                })
            } else {
                noHandlerFoundError = true
                throw new Error(`[crx-bridge] No handler registered in '${context}' to accept messages with id '${messageID}'`)
            }
        } catch (error) {
            err = error
        } finally {
            if (err) { message.err = serializeError(err); }

            routeMessage({
                ...message,
                messageType: 'reply',
                data: reply,
                origin: { context, tabId: null },
                destination: message.origin,
                hops: [],
            })

            if (err && !noHandlerFoundError) {
                throw reply;
            }
        }
    }

    switch (messageType) {
        case 'reply': return handleReply();
        case 'message': return handleNewMessage();
    }
}

async function handleWindowOnMessage({ data, ports }) {
    if (context === RuntimeContext.ContentScript && !isWindowMessagingAllowed) {
        return;
    }

    if (data.cmd === '__crx_bridge_verify_listening' && data.scope === namespace && data.context !== context) {
        const msgPort = ports[0]
        msgPort.postMessage(true)
        return
    } else if (data.cmd === '__crx_bridge_route_message' && data.scope === namespace && data.context !== context) {
        // a message event insdide `content-script` means a script inside `window` dispactched it
        // so we're making sure that the origin is not tampered (i.e script is not masquerading it's true identity)
        if (context === RuntimeContext.ContentScript) {
            data.payload.origin.context = 'window'
        }

        routeMessage(data.payload)
    }
}

function routeMessageThroughWindow(win, msg) {
    ensureNamespaceSet();

    const channel = new MessageChannel();
    const retry = setTimeout(() => {
        channel.port1.onmessage = null;
        routeMessageThroughWindow(win, msg);
    }, 300);
    channel.port1.onmessage = () => {
        clearTimeout(retry);
        win.postMessage({
            cmd: '__crx_bridge_route_message',
            scope: namespace,
            context: context,
            payload: msg,
        }, '*');
    }
    win.postMessage({
        cmd: '__crx_bridge_verify_listening',
        scope: namespace,
        context: context
    }, '*', [channel.port2])
}

function ensureNamespaceSet() {
    if (typeof namespace !== 'string' || namespace.length === 0) {
        throw new Error(oneline`
            crx-bridge uses window.postMessage to talk with other "window"(s), for message routing and stuff,
            which is global/conflicting operation in case there are other scripts using crx-bridge. 
            Call Bridge#setNamespace(nsps) to isolate your app. Example: Bridge.setNamespace('com.facebook.react-devtools'). 
            Make sure to use same namespace across all your scripts whereever window.postMessage is likely to be used
        `);
    }
}
