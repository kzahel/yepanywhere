import { PushNotificationToggle } from "../../components/PushNotificationToggle";

export function NotificationsSettings() {
  return (
    <section className="settings-section">
      <h2>Notifications</h2>
      <div className="settings-group">
        <PushNotificationToggle />
      </div>
    </section>
  );
}
