const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');

test('embedded notification button never requests cross-origin permission', async () => {
  const start = source.indexOf('async function enableNotifications()');
  const end = source.indexOf('document.getElementById("notifyToggle").addEventListener', start);
  let requested = false;
  let status = '';
  const window = {isSecureContext: true, PushManager: function() {}};
  window.self = window;
  window.top = {};
  const context = vm.createContext({window, swRegistration: Promise.resolve({}), navigator: {serviceWorker: {}}, Notification: {requestPermission: async () => {requested = true; return 'denied';}}, setNotifyStatus: text => status = text, document: {getElementById: () => ({classList: {add() {}}})}});
  vm.runInContext(source.slice(start, end), context);
  await context.enableNotifications();
  assert.equal(requested, false);
  assert.match(status, /dashboard.*Notifications/i);
});
