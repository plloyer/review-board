// Take over immediately on update instead of waiting for every tab to close —
// this is a personal single-purpose tool, always run the latest logic.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Review board", body: "New item" };
  if (data.closeTag) {
    // Answered on another device — close this one's copy of the notification, if shown.
    event.waitUntil(
      self.registration.getNotifications({ tag: data.closeTag }).then((notifications) => {
        notifications.forEach((n) => n.close());
      })
    );
    return;
  }
  event.waitUntil(
    self.registration.showNotification(data.title, { body: data.body, icon: "/icon.png", tag: data.tag })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
