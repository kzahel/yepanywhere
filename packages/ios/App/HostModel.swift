import Foundation
import SwiftUI
import WebKit

@MainActor
final class HostModel: ObservableObject {
  @Published var catalog = HostCatalog()
  @Published var webView: WKWebView?
  @Published var busy = false
  @Published var error: String?
  @Published var reauthenticate: HostProfile?
  @Published var adding = false
  @Published var forgetAnyway: HostProfile?
  @Published var catalogAvailable = false
  private var started = false
  private(set) var connections = NativeRuntime()
  private let store: HostStore
  private let security: SecurityClientCoordinator
  private var bridge: NativeBridge?
  private var work: Task<Void, Never>?
  private var generation = UUID()
  private var suspendedProfile: HostProfile?
  let notifications: NativeNotifications
  init(store: HostStore = HostStore()) {
    self.store = store; security = SecurityClientCoordinator(store: store)
    // Acceptance catalogs must never retire the user's push bindings.
    let pushService =
      store.service == "com.yepanywhere.ios.hosts.v1"
      ? "com.yepanywhere.ios.push.v1" : store.service + ".push.v1"
    notifications = NativeNotifications(store: HostStore(service: pushService))
    do { catalog = try store.catalog(); catalogAvailable = true } catch {
      self.error = "Saved hosts are unavailable. Unlock the device and try again."
    }
    notifications.knownHost = { [weak self] id in
      guard let self,
        let profile = self.catalog.profiles.first(where: { $0.id == id && $0.forgetting != true })
      else { return false }
      do { try self.security.requireUnrevoked(profile); return true } catch { return false }
    }
    notifications.currentClientID = { [weak self] id in
      guard let self,
        let profile = self.catalog.profiles.first(where: { $0.id == id && $0.forgetting != true })
      else { return nil }
      return try? self.security.pushClientID(profile)
    }
    notifications.openHost = { [weak self] id, sessionID in
      guard let self, let profile = self.catalog.profiles.first(where: { $0.id == id }) else {
        return
      }
      self.open(profile, pushSessionID: sessionID)
    }
  }
  var activeProfile: HostProfile? { catalog.profiles.first { $0.id == catalog.selected } }
  var activeTab: HostTab? { activeProfile.flatMap { catalog.lastTab($0.id) } }

  func newTab(_ profile: HostProfile, path: String = "/projects", foreground: Bool = true) {
    do {
      var updated = try store.catalog()
      var tabs = updated.tabs ?? []
      guard tabs.count < 32 else { error = "Close a tab before opening another."; return }
      var tab = HostTab(profileID: profile.id, path: HostTab.savedPath(path))
      if !foreground { tab.selected = .distantPast }
      tabs.append(tab); updated.tabs = tabs
      try store.save(updated); catalog = updated
      if foreground { open(profile) }
    } catch { self.error = "Could not save the new tab." }
  }
  func selectTab(_ tab: HostTab) {
    guard let profile = catalog.profiles.first(where: { $0.id == tab.profileID }) else { return }
    if activeTab?.id == tab.id, webView != nil { return }
    do {
      var updated = try store.catalog()
      guard let i = updated.tabs?.firstIndex(where: { $0.id == tab.id }) else { return }
      updated.tabs?[i].selected = Date()
      try store.save(updated); catalog = updated; open(profile)
    } catch { self.error = "Could not select the tab." }
  }
  func closeTab(_ tab: HostTab) {
    let active = activeTab?.id == tab.id
    do {
      var updated = try store.catalog()
      updated.tabs?.removeAll { $0.id == tab.id }
      let next = updated.lastTab(tab.profileID) ?? updated.tabs?.last
      if active { updated.selected = next?.profileID }
      try store.save(updated); catalog = updated
      if active {
        if let next, let profile = catalog.profiles.first(where: { $0.id == next.profileID }) {
          open(profile)
        } else {
          switchHost()
        }
      }
    } catch { self.error = "Could not close the tab." }
  }
  func switchHost() {
    let retiring = webView
    Task {
      _ = try? await retiring?.evaluateJavaScript(
        "window.dispatchEvent(new Event('pagehide'));true")
    }
    generation = UUID(); work?.cancel(); work = nil; busy = false
    bridge?.close(); bridge = nil; webView = nil; suspendedProfile = nil
  }
  func login(label: String, endpoint: String, target: String?, username: String, password: String) {
    guard catalogAvailable else { return }
    switchHost(); error = nil; busy = true
    let token = generation
    let prior = reauthenticate
    let profile =
      prior
      ?? HostProfile(
        id: UUID().uuidString, label: label.isEmpty ? username : label, endpoint: endpoint,
        relayTarget: target, username: username, lastConnected: Date())
    guard catalog.profiles.count < 20 || prior != nil else {
      busy = false; error = "You can save up to 20 hosts."; return
    }
    work = Task {
      do {
        try security.requireUnrevoked(profile)
        let persistence = SavedCredential(store: store, profile: profile, pairing: prior == nil) {
          [weak self] in self?.catalog = $0
        }
        let session = try await connections.login(
          profileId: profile.id, route: profile.nativeRoute, username: profile.username,
          password: password, storage: persistence)
        guard generation == token, !Task.isCancelled else { session.close(); return }
        do {
          try await security.ensure(profile, session: session)
          guard generation == token, !Task.isCancelled else { session.close(); return }
          try show(profile, session: session)
          adding = false; reauthenticate = nil
        } catch { session.close(); throw error }
      } catch {
        if generation == token {
          self.error =
            error is NativeSecurityFailure
            ? "This installation could not prove continuity. A revoked host must be forgotten before pairing again."
            : "Could not sign in. Check the host, username and password."
        }
      }
      if generation == token {
        if catalog.profiles.contains(where: { $0.id == profile.id }) { adding = false }
        busy = false; work = nil
      }
    }
  }
  func open(_ profile: HostProfile, pushSessionID: String? = nil) {
    guard catalogAvailable else { return }
    if profile.forgetting == true { forget(profile); return }
    adding = false; reauthenticate = nil
    switchHost(); error = nil; busy = true
    let token = generation
    work = Task {
      do {
        try security.requireUnrevoked(profile)
        try await connections.settleCredential(profileId: profile.id)
        guard generation == token else { return }
        guard let credential = try store.credential(profile.id) else {
          reauthenticate = profile; busy = false; return
        }
        let session = try await connections.acquireForeground(
          profileId: profile.id, routes: [profile.nativeRoute], username: profile.username,
          credential: credential,
          storage: SavedCredential(store: store, profile: profile), quickRetries: true)
        guard generation == token, !Task.isCancelled else { session.close(); return }
        do {
          try await security.ensure(profile, session: session)
          guard generation == token, !Task.isCancelled else { session.close(); return }
          if let pushSessionID,
            let route = try await notifications.destination(
              profile.id, sessionID: pushSessionID, session: session, security: security)
          {
            var updated = try store.catalog()
            if let tab = updated.lastTab(profile.id),
              let i = updated.tabs?.firstIndex(where: { $0.id == tab.id })
            {
              updated.tabs?[i].path = route; try store.save(updated); catalog = updated
            } else {
              try store.write("route." + profile.id, Data(route.utf8))
            }
          }
          guard generation == token, !Task.isCancelled else { session.close(); return }
          try show(profile, session: session)
        } catch { session.close(); throw error }
        reauthenticate = nil
      } catch {
        guard generation == token else { return }
        if case CoreError.ReauthenticationRequired = error {
          try? store.forgetCredential(profile.id); reauthenticate = profile
          self.error = "This host requires you to sign in again."
        } else if case NativeSecurityFailure.revoked = error {
          self.error = "This installation was revoked. Forget this host before pairing again."
        } else if error as? CoreError == .Unavailable || error as? CoreError == .Timeout {
          do { try show(profile, session: nil, pendingPush: pushSessionID) } catch {
            self.error = "Could not open the saved host."
          }
        } else {
          self.error = "Could not verify this host."
        }
      }
      if generation == token { busy = false; work = nil }
    }
  }
  private func show(_ profile: HostProfile, session: NativeSourceLease?, pendingPush: String? = nil)
    throws
  {
    guard let root = Bundle.main.url(forResource: "web", withExtension: nil) else {
      throw BridgeFailure.closed
    }
    let saved = try store.read("route." + profile.id).flatMap { String(data: $0, encoding: .utf8) }
    let legacyRoute =
      saved.flatMap { $0.utf8.count <= 4096 && $0.hasPrefix("/") && !$0.hasPrefix("//") ? $0 : nil }
      ?? "/"
    var updated = try store.catalog()
    var tabs = updated.tabs ?? []
    let tab: HostTab
    if let existing = updated.lastTab(profile.id) {
      tab = existing
    } else {
      guard tabs.count < 32 else { throw BridgeFailure.overflow }
      tab = HostTab(profileID: profile.id, path: HostTab.savedPath(legacyRoute))
      tabs.append(tab); updated.tabs = tabs
    }
    updated.selected = profile.id; try store.save(updated); catalog = updated
    let route = HostTab.savedPath(tab.path)
    guard let url = URL(string: BundledAssets.origin + route), url.scheme == BundledAssets.scheme,
      url.host == BundledAssets.host
    else { throw BridgeFailure.invalidCommand }
    let source = RustSource(profile: profile, session: session)
    let token = generation
    source.acquire = { [weak self] retry in
      guard let self, self.generation == token else { throw CancellationError() }
      try await self.connections.settleCredential(profileId: profile.id)
      try Task.checkCancellation()
      try self.security.requireUnrevoked(profile)
      guard let credential = try self.store.credential(profile.id) else {
        throw CoreError.ReauthenticationRequired
      }
      return try await self.connections.acquireForeground(
        profileId: profile.id, routes: [profile.nativeRoute], username: profile.username,
        credential: credential, storage: SavedCredential(store: self.store, profile: profile),
        quickRetries: retry)
    }
    var pending = pendingPush
    source.checkIn = { [weak self] lease in
      guard let self, self.generation == token else { throw CancellationError() }
      try await self.security.ensure(profile, session: lease)
      if let id = pending,
        let path = try await self.notifications.destination(
          profile.id, sessionID: id, session: lease, security: self.security),
        self.generation == token
      {
        pending = nil
        _ = try await self.webView?.callAsyncJavaScript(
          "history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate'))",
          arguments: ["path": path], in: nil, contentWorld: .page)
      }
    }
    let bridge = NativeBridge(source: source)
    bridge.reauthenticationRequired = { [weak self] revoked in
      guard let self else { return }
      self.switchHost(); try? self.store.forgetCredential(profile.id)
      if revoked {
        self.error = "This installation was revoked. Forget this host before pairing again."
      } else {
        self.reauthenticate = profile; self.error = "This host requires you to sign in again."
      }
    }
    bridge.showError = { [weak self] message in self?.error = message }
    bridge.shareFile = { [weak self] file, done in
      guard let presenter = self?.webView?.window?.rootViewController,
        presenter.presentedViewController == nil
      else { done(); return }
      let controller = UIActivityViewController(activityItems: [file], applicationActivities: nil)
      controller.completionWithItemsHandler = { _, _, _, _ in done() }
      controller.popoverPresentationController?.sourceView = presenter.view
      controller.popoverPresentationController?.sourceRect = CGRect(
        x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY, width: 1, height: 1)
      presenter.present(controller, animated: true)
    }
    bridge.routeChanged = { [weak self] route in
      guard let self, self.generation == token, var updated = try? self.store.catalog(),
        let i = updated.tabs?.firstIndex(where: { $0.id == tab.id })
      else { return }
      let path = HostTab.savedPath(route)
      guard updated.tabs?[i].path != path else { return }
      updated.tabs?[i].path = path
      do { try self.store.save(updated); self.catalog = updated } catch {
        self.error = "Could not save the tab location."
      }
    }
    bridge.openTab = { [weak self] path, foreground in
      self?.newTab(profile, path: path, foreground: foreground)
    }
    bridge.switchHost = { [weak self] in self?.switchHost() }
    bridge.notificationStatus = { [weak self] in await self?.notifications.status() ?? [:] }
    bridge.requestPermission = { [weak self] in await self?.notifications.requestPermission() ?? [:]
    }
    let view = bridge.makeWebView(root: root)
    self.bridge = bridge; webView = view
    view.load(URLRequest(url: url))
  }
  func forget(_ profile: HostProfile, anyway: Bool = false) {
    guard catalogAvailable else { return }
    switchHost(); error = nil; forgetAnyway = nil; busy = true
    let token = generation
    work = Task {
      do {
        if !anyway, profile.forgetting != true {
          guard let credential = try store.credential(profile.id) else {
            throw BridgeFailure.closed
          }
          let session = try await connections.acquire(
            profileId: profile.id, routes: [profile.nativeRoute], username: profile.username,
            credential: credential,
            storage: SavedCredential(store: store, profile: profile))
          defer { session.close() }
          try await security.revoke(profile, session: session)
        }
        guard generation == token, !Task.isCancelled else { return }
        // The durable tombstone retains a visible retry owner until every local
        // cleanup succeeds; it also prevents resuming a partially removed host.
        connections.retireProfile(profileId: profile.id)
        catalog = try store.markForRemoval(profile.id)
        try? await notifications.forget(profile.id)
        try store.delete("route." + profile.id)
        if let id = UUID(uuidString: profile.id) {
          try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            WKWebsiteDataStore.remove(forIdentifier: id) { error in
              if let error { done.resume(throwing: error) } else { done.resume() }
            }
          }
        }
        try security.forget(profile)
        catalog = try store.remove(profile.id)
        if reauthenticate?.id == profile.id { reauthenticate = nil }
      } catch {
        if generation == token {
          self.error =
            "Could not finish removing this host. Retry, or forget locally without confirming server revocation."
          if profile.forgetting != true { forgetAnyway = profile }
        }
      }
      if generation == token { busy = false; work = nil }
    }
  }
  enum PushAction { case enable, disable, test }
  func pushEnabled(_ profile: HostProfile) -> Bool { notifications.enabled(profile.id) }
  func push(_ profile: HostProfile, action: PushAction) {
    guard catalogAvailable, !busy else { return }
    error = nil; busy = true
    let token = generation
    work = Task {
      do {
        try security.requireUnrevoked(profile)
        if action == .disable {
          // Broker revocation also works when the YA host cannot be reached.
          try notifications.retire(profile.id)
          try await notifications.forget(profile.id)
          if generation == token { busy = false; work = nil; objectWillChange.send() }
          return
        }
        guard let credential = try store.credential(profile.id) else {
          reauthenticate = profile; throw BridgeFailure.closed
        }
        let session = try await connections.acquire(
          profileId: profile.id, routes: [profile.nativeRoute], username: profile.username,
          credential: credential, storage: SavedCredential(store: store, profile: profile))
        defer { session.close() }
        try await security.ensure(profile, session: session)
        guard generation == token, !Task.isCancelled else { return }
        switch action {
        case .enable:
          try await notifications.enable(
            profile, clientID: security.pushClientID(profile), session: session, security: security)
        case .disable:
          try await notifications.disable(profile, session: session, security: security)
        case .test: try await notifications.test(profile, session: session, security: security)
        }
      } catch {
        guard generation == token else { return }
        if case NativePushFailure.updateRequired = error {
          self.error = "Update this YA server to enable native notifications."
        } else {
          self.error =
            "Could not update notifications. Check notification permission and your connection, then retry."
        }
      }
      if generation == token { busy = false; work = nil; objectWillChange.send() }
    }
  }
  func background() {
    let profile = webView == nil ? nil : catalog.profiles.first { $0.id == catalog.selected }
    // Flush React's existing draft owner before discarding its document.
    // Closing native transport is immediate; pending source operations stop.
    bridge?.close(); notifications.background()
    for host in catalog.profiles { connections.retireProfile(profileId: host.id) }
    let view = webView
    generation = UUID()
    let token = generation
    work?.cancel(); work = nil; busy = false
    suspendedProfile = profile ?? suspendedProfile
    Task { [weak self] in
      _ = try? await view?.evaluateJavaScript("window.dispatchEvent(new Event('pagehide'))")
      guard let self, self.generation == token else { return }
      self.bridge = nil; self.webView = nil
    }
  }
  func start() { guard !started else { return }; started = true; foreground() }
  func foreground() {
    notifications.foreground()
    if !catalogAvailable {
      do { catalog = try store.catalog(); catalogAvailable = true; error = nil } catch { return }
    }
    if let profile = suspendedProfile {
      suspendedProfile = nil; open(profile)
    } else if started, webView == nil, !busy, error == nil, let id = catalog.selected,
      let profile = catalog.profiles.first(where: { $0.id == id })
    {
      open(profile)
    }
  }
}
