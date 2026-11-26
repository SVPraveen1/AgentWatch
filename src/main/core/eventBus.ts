import { EventEmitter } from 'node:events';
import type { NormalizedEvent } from '../../shared/types';

export interface AppEventMap {
  normalized_event: [NormalizedEvent];
  state_changed: [];
}

export class CoreEventBus extends EventEmitter<AppEventMap> {
  emitNormalizedEvent(event: NormalizedEvent): void {
    this.emit('normalized_event', event);
  }

  emitStateChanged(): void {
    this.emit('state_changed');
  }
}
