import { EventEmitter } from 'events';
import uuid from 'tiny-uid';

import { Stream } from './Stream.js';
import {
    sendMessage,
    onMessage,
    allowWindowMessaging,
    setNamespace,
    parseEndpoint,
    isInternalEnpoint
} from './internal.js';


const openStreams = new Map();
const onOpenStreamCallbacks = new Map()
const streamyEmitter = new EventEmitter()

onMessage('__crx_bridge_stream_open__', (message) => {
    return new Promise((resolve) => {
        const { sender, data } = message
        const { channel } = data
        let watching = false
        const readyup = () => {
            const callback = onOpenStreamCallbacks.get(channel)

            if (typeof callback === 'function') {
                callback(new Stream({ ...data, endpoint: sender }))
                if (watching) {
                    streamyEmitter.removeListener('did-change-stream-callbacks', readyup)
                }
                resolve(true);
            } else if (!watching) {
                watching = true;
                streamyEmitter.on('did-change-stream-callbacks', readyup)
            }
        };

        readyup();
    });
});

async function openStream(channel, destination){
    if (openStreams.has(channel)) {
        throw new Error('crx-bridge: A Stream is already open at this channel');
    }

    const endpoint = typeof destination === 'string' ? parseEndpoint(destination) : destination

    const streamInfo = { streamId: uuid(), channel, endpoint }
    const stream = new Stream(streamInfo)
    stream.onClose(() => openStreams.delete(channel))
    await sendMessage('__crx_bridge_stream_open__', streamInfo, endpoint)
    openStreams.set(channel, stream)
    return stream;
}

function onOpenStreamChannel(channel, callback){
    if (onOpenStreamCallbacks.has(channel)) {
        throw new Error('crx-bridge: This channel has already been claimed. Stream allows only one-on-one communication')
    }

    onOpenStreamCallbacks.set(channel, callback)
    streamyEmitter.emit('did-change-stream-callbacks')
}

export {
    isInternalEnpoint,
    sendMessage,
    onMessage,
    allowWindowMessaging,
    setNamespace,
    openStream,
    onOpenStreamChannel
}
