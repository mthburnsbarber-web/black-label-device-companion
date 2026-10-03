import { Controller, Device, MockClipboard } from './core.js';

const mini = new Device('mini', new MockClipboard('Hello from the in-memory mock.'));
const laptop = new Device('laptop');
mini.enable(); laptop.enable();
const result = await new Controller([mini, laptop]).transfer('mini', 'laptop', { consent: true });
console.log(JSON.stringify({ receipt: result.receipt, targetMockText: laptop.clipboard.snapshot().text }, null, 2));
