import { QueueModule } from './queue.module';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

describe('QueueModule', () => {
  it('is defined and exports the correct queue name constant', () => {
    expect(QueueModule).toBeDefined();
    expect(VIDEO_PROCESSING_QUEUE).toBe('video-processing');
  });
});
