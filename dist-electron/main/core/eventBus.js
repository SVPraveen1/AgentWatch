"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoreEventBus = void 0;
const node_events_1 = require("node:events");
class CoreEventBus extends node_events_1.EventEmitter {
    emitNormalizedEvent(event) {
        this.emit('normalized_event', event);
    }
    emitStateChanged() {
        this.emit('state_changed');
    }
}
exports.CoreEventBus = CoreEventBus;
