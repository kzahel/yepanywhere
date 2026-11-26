# iOS HTML previews cannot load sibling files

The native viewer runs self-contained HTML in a separate nonpersistent WebView. Its CSP blocks all network requests. A report that needs a sibling stylesheet, image or script therefore renders incompletely. The Android managed viewer can resolve resources inside a granted artifact. Supporting those resources on iOS requires a grant-scoped WebKit resource handler and tests of directory bounds, expiry and navigation.

The original Blob-export and self-contained-preview gaps have simulator coverage in `DocumentDeliveryTests`.

Found 2026-10-01 while implementing the iOS shell. Narrowed 2026-11-26 after adding the WebKit viewer and share adapter.
