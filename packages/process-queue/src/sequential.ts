import type {ProcessQueueOptions} from './api.js';
import {ConcurrentProcessQueue} from './concurrent.js';

/**
 * Processes one task at a time, in push order. `maxProcessing` does not apply.
 */
export class SequentialProcessQueue<Task> extends ConcurrentProcessQueue<Task> {
    constructor(options: ProcessQueueOptions<Task>) {
        super({...options, maxProcessing: 1});
    }
}
