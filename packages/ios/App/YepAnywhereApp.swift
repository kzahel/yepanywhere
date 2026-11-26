import AppIntents
import SwiftUI
import WebKit

@main
struct YepAnywhereApp: App {
  @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var appDelegate
  @StateObject private var hosts: HostModel
  @Environment(\.scenePhase) private var phase
  init() {
    #if DEBUG
      let qa = ProcessInfo.processInfo.arguments.contains("-qa-input-metrics")
      let store = HostStore(
        service: qa ? "com.yepanywhere.ios.acceptance" : "com.yepanywhere.ios.hosts.v1")
      if qa && ProcessInfo.processInfo.arguments.contains("-qa-reset-hosts") {
        try? store.delete("hosts-state.v1")
      }
      _hosts = StateObject(wrappedValue: HostModel(store: store))
    #else
      _hosts = StateObject(wrappedValue: HostModel())
    #endif
  }
  var body: some Scene {
    WindowGroup {
      HostScreen(hosts: hosts).task { hosts.start() }.onReceive(
        NotificationCenter.default.publisher(
          for: UIApplication.protectedDataDidBecomeAvailableNotification)
      ) { _ in hosts.foreground() }.onChange(of: phase) { _, phase in
        if phase == .background {
          hosts.background()
        } else if phase == .active {
          hosts.foreground()
        }
      }
    }
  }
}
private struct WebScreen: UIViewRepresentable {
  let view: WKWebView
  func makeUIView(context: Context) -> WKWebView { view }
  func updateUIView(_ uiView: WKWebView, context: Context) {}
}
private struct HostScreen: View {
  @ObservedObject var hosts: HostModel
  enum PickerSheet: String, Identifiable {
    case hosts, tabs
    var id: String { rawValue }
  }
  @State private var sheet: PickerSheet?
  var body: some View {
    Group {
      if let web = hosts.webView {
        VStack(spacing: 0) {
          HStack {
            Button {
              sheet = .hosts
            } label: {
              Label(hosts.activeProfile?.label ?? "Switch host", systemImage: "chevron.down")
                .lineLimit(1)
            }.accessibilityIdentifier("host-switcher")
            Spacer()
            Button {
              sheet = .tabs
            } label: {
              Label("Tabs (\(hosts.catalog.tabs?.count ?? 0))", systemImage: "square.on.square")
            }.accessibilityIdentifier("host-tabs")
          }.padding(.horizontal).frame(minHeight: 44)
          if let error = hosts.error {
            HStack {
              Text(error).font(.callout)
              Spacer()
              Button("Dismiss") { hosts.error = nil }
            }.padding(.horizontal)
          }
          Divider()
          WebScreen(view: web).id(ObjectIdentifier(web)).ignoresSafeArea(.container, edges: .bottom)
        }
      } else {
        management
      }
    }
    .tint(
      Color(
        uiColor: UIColor { style in
          style.userInterfaceStyle == .dark
            ? UIColor(red: 0.20, green: 0.83, blue: 0.60, alpha: 1)
            : UIColor(red: 0.016, green: 0.47, blue: 0.34, alpha: 1)
        })
    )
    .sheet(item: $sheet) { picker in
      NavigationStack {
        List {
          if picker == .tabs {
            ForEach(hosts.catalog.tabs ?? []) { tab in
              HStack {
                Button {
                  sheet = nil; hosts.selectTab(tab)
                } label: {
                  VStack(alignment: .leading) {
                    Text(
                      tab.id == hosts.activeTab?.id ? hosts.webView?.title ?? tab.path : tab.path
                    )
                    .lineLimit(1)
                    Text(hosts.catalog.profiles.first { $0.id == tab.profileID }?.label ?? "")
                      .font(.caption).foregroundStyle(.secondary)
                  }.frame(minHeight: 44)
                }
                Spacer()
                Button {
                  hosts.closeTab(tab); if hosts.catalog.tabs?.isEmpty == true { sheet = nil }
                } label: {
                  Image(systemName: "xmark")
                }.frame(minWidth: 44, minHeight: 44).accessibilityLabel("Close tab")
              }.buttonStyle(.borderless)
            }
            Button("New tab") {
              if let host = hosts.activeProfile { sheet = nil; hosts.newTab(host) }
            }
            Button("Switch host") { sheet = .hosts }
          } else {
            ForEach(hosts.catalog.profiles.filter { $0.forgetting != true }) { profile in
              Button(profile.label) {
                sheet = nil
                if hosts.activeProfile?.id != profile.id || hosts.webView == nil {
                  hosts.open(profile)
                }
              }
            }
            Button("Add host") {
              sheet = nil; hosts.switchHost(); hosts.adding = true
            }
            Button("Manage hosts") {
              sheet = nil; hosts.switchHost()
            }
          }
          if let error = hosts.error { Text(error).foregroundStyle(.red) }
        }.navigationTitle(picker == .tabs ? "Tabs" : "Switch host")
          .toolbar { Button("Done") { sheet = nil } }
      }.presentationDetents([.medium, .large])
    }
  }
  private var management: some View {
    NavigationStack {
      Group {
        if hosts.reauthenticate != nil || hosts.adding || hosts.catalog.profiles.isEmpty {
          ScrollView {
            LoginForm(hosts: hosts, profile: hosts.reauthenticate).id(
              hosts.reauthenticate?.id ?? "new"
            )
            .frame(maxWidth: 520).padding(22).frame(maxWidth: .infinity)
          }.navigationTitle("Connect to your host")
        } else {
          List {
            if let error = hosts.error {
              Text(error).foregroundStyle(.red).accessibilityIdentifier("host-error")
            }
            if hosts.busy { ProgressView("Connecting…") }
            Section("Saved hosts") {
              ForEach(hosts.catalog.profiles) { profile in
                Button {
                  hosts.open(profile)
                } label: {
                  VStack(alignment: .leading) {
                    Text(
                      profile.label + (profile.forgetting == true ? " (removal incomplete)" : ""));
                    Text(profile.username).font(.caption).foregroundStyle(.secondary)
                  }.frame(minHeight: 44)
                }.disabled(hosts.busy || !hosts.catalogAvailable)
                  .swipeActions { Button("Forget", role: .destructive) { hosts.forget(profile) } }
                HStack {
                  Button(
                    hosts.pushEnabled(profile) ? "Disable notifications" : "Enable notifications"
                  ) {
                    hosts.push(profile, action: hosts.pushEnabled(profile) ? .disable : .enable)
                  }.accessibilityIdentifier("host-push-" + profile.id)
                  if hosts.pushEnabled(profile) {
                    Button("Send test") { hosts.push(profile, action: .test) }
                  }
                }.buttonStyle(.borderless).disabled(hosts.busy || profile.forgetting == true)
              }
            }
            Button("Add host") { hosts.adding = true }.accessibilityIdentifier("host-add")
          }.navigationTitle("Saved hosts")
        }
      }.navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
          "Server revocation could not be confirmed",
          isPresented: Binding(
            get: { hosts.forgetAnyway != nil }, set: { if !$0 { hosts.forgetAnyway = nil } }
          )
        ) {
          if let profile = hosts.forgetAnyway {
            Button("Forget anyway", role: .destructive) { hosts.forget(profile, anyway: true) }
          }
          Button("Cancel", role: .cancel) { hosts.forgetAnyway = nil }
        } message: {
          Text(
            "This removes local keys and drafts. The server may still list this installation; revoke it from Security settings on another device."
          )
        }
        .toolbar {
          if hosts.busy {
            Button("Cancel") { hosts.switchHost() }
          } else if hosts.adding || hosts.reauthenticate != nil {
            Button("Cancel") {
              hosts.adding = false; hosts.reauthenticate = nil; hosts.error = nil
            }
          }
        }
    }
  }
}
private struct LoginForm: View {
  @ObservedObject var hosts: HostModel
  let profile: HostProfile?
  @State private var endpoint = "wss://relay.yepanywhere.com/ws"
  @State private var relay = true
  @State private var advanced = false
  @State private var username = ""
  @State private var password = ""
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 8) {
        ZStack {
          RoundedRectangle(cornerRadius: 8).fill(Color(red: 0.016, green: 0.47, blue: 0.34))
          Path { path in
            path.move(to: CGPoint(x: 11, y: 14)); path.addLine(to: CGPoint(x: 16, y: 20))
            path.addLine(to: CGPoint(x: 25, y: 11))
            path.move(to: CGPoint(x: 16, y: 20)); path.addLine(to: CGPoint(x: 16, y: 27))
          }.stroke(.white, style: StrokeStyle(lineWidth: 3.2, lineCap: .round, lineJoin: .round))
        }.frame(width: 36, height: 36).accessibilityHidden(true)
        Text("yepanywhere").font(.system(.title2, design: .serif).weight(.semibold))
      }
      Text(
        profile == nil
          ? "Use the credentials from Settings → Remote Access on your host."
          : "Sign in again to connect to your saved host."
      )
      .foregroundStyle(.secondary)
      if let error = hosts.error {
        Text(error).foregroundStyle(.red).accessibilityIdentifier("host-error")
      }
      if let profile {
        Text(profile.label)
        Text(profile.username).foregroundStyle(.secondary)
      } else {
        TextField(relay ? "Server name" : "Username", text: $username).textContentType(.username)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .accessibilityIdentifier("host-username").modifier(ConnectionField())
      }
      SecureField("Password", text: $password).textContentType(.password)
        .accessibilityIdentifier("host-password").modifier(ConnectionField())
      if profile == nil {
        Button {
          advanced.toggle()
        } label: {
          HStack {
            Text("Connection options")
            Image(systemName: advanced ? "chevron.up" : "chevron.down").font(.caption)
          }.frame(maxWidth: .infinity, minHeight: 44)
        }.accessibilityIdentifier("host-advanced")
        if advanced {
          Picker("Connection", selection: $relay) {
            Text("Relay").tag(true)
            Text("Direct").tag(false)
          }.pickerStyle(.segmented).onChange(of: relay) { _, relay in
            endpoint = relay ? "wss://relay.yepanywhere.com/ws" : ""
          }
          TextField(relay ? "Relay WebSocket URL" : "Server URL", text: $endpoint)
            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            .accessibilityIdentifier("host-url").modifier(ConnectionField())
        }
      }
      Button(action: connect) {
        if hosts.busy {
          ProgressView().frame(maxWidth: .infinity)
        } else {
          Text("Connect host").fontWeight(.semibold).frame(maxWidth: .infinity)
        }
      }.buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("host-sign-in")
      Link("Privacy policy", destination: URL(string: "https://yepanywhere.com/privacy")!)
        .frame(minHeight: 44)
    }.disabled(hosts.busy || !hosts.catalogAvailable)
  }
  private func connect() {
    let entered = username.trimmingCharacters(in: .whitespacesAndNewlines)
    guard profile != nil || !entered.isEmpty, !password.isEmpty else {
      hosts.error = "Enter your server credentials."; return
    }
    guard let url = normalizedEndpoint() else { hosts.error = "Enter a valid server URL."; return }
    let secret = password; password = ""
    let user = profile?.username ?? (relay ? entered.lowercased() : entered)
    hosts.login(
      label: profile?.label ?? user, endpoint: url, target: relay ? user : nil,
      username: user, password: secret)
  }
  private func normalizedEndpoint() -> String? {
    if let profile { return profile.endpoint }
    guard var url = URLComponents(string: endpoint.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = url.scheme,
      ["http", "https", "ws", "wss"].contains(scheme), url.host != nil, url.user == nil,
      url.password == nil, url.fragment == nil
    else { return nil }
    if scheme == "http" || scheme == "https" {
      url.scheme = scheme == "https" ? "wss" : "ws"
      if url.path.isEmpty || url.path == "/" { url.path = relay ? "/ws" : "/api/ws" }
    }
    return url.string
  }
}

private struct ConnectionField: ViewModifier {
  func body(content: Content) -> some View {
    content.padding(.horizontal, 14).frame(minHeight: 52)
      .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.55)))
  }
}
