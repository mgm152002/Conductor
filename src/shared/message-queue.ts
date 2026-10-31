// Messages sent while a task in the thread is still working.
// `steer` interrupts the running task and runs the message next as a
// follow-up; `queue` lets the running task finish, then runs FIFO.

export type QueuedMessageMode = 'steer' | 'queue';

export type QueuedMessageStatus = 'pending' | 'dispatching' | 'dispatched' | 'cancelled' | 'failed';

export interface QueuedMessage {
  id: string;
  /** Task that was working when the message was sent. */
  anchorTaskId: string;
  threadId: string;
  objective: string;
  mode: QueuedMessageMode;
  status: QueuedMessageStatus;
  createdAt: string;
  /** Follow-up task created when this message was dispatched. */
  dispatchedTaskId?: string;
}
