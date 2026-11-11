#if DEBUG
  import WebKit

  enum InputAcceptance {
    static func install(_ configuration: WKWebViewConfiguration) {
      guard ProcessInfo.processInfo.arguments.contains("-qa-input-metrics") else { return }
      let script = """
        (() => {
          // Keep the last actual DOM pointer delivery in failure hierarchies.
          // This separates a missed native tap from a missing readiness event.
          for (const type of ['pointerdown', 'click']) {
            document.addEventListener(type, event => {
              let report = document.getElementById('qa-pointer-metrics');
              if (!report) {
                report = document.createElement('div'); report.id = 'qa-pointer-metrics';
                report.style.cssText = 'position:fixed;top:24px;right:0;z-index:99998;font:10px monospace;background:white;color:black;pointer-events:none';
                document.body.append(report);
              }
              const target = event.target;
              const control = target.closest?.('[data-composer-input], [data-sidebar-toggle], [data-sidebar-switch-host]');
              const name = control?.hasAttribute('data-composer-input') ? 'composer' : control?.hasAttribute('data-sidebar-toggle') ? 'sidebar' : control?.hasAttribute('data-sidebar-switch-host') ? 'switchHost' : target.tagName;
              report.textContent = `QA pointer ${type}=${name};x=${Math.round(event.clientX)};y=${Math.round(event.clientY)};time=${Math.round(performance.now())}`;
            }, true);
          }
          // XCTest can expose the drawer's final AX frame before WebKit paints
          // it (CI 38249220195). Gate its tap on the actual DOM hit target and
          // two rendering frames, rather than a fixed sleep or an AX snapshot.
          document.addEventListener('click', event => {
            if (!event.target.closest?.('[aria-label="Open sidebar"]')) return;
            document.getElementById('qa-host-switch-ready')?.remove();
            const deadline = performance.now() + 5000;
            let frames = 0;
            const check = () => {
              const button = document.querySelector('[data-sidebar-switch-host]');
              const rect = button?.getBoundingClientRect();
              const hit = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              const settled = button?.closest('aside')?.getAnimations().every(animation => animation.playState !== 'running');
              frames = settled && rect && rect.width > 0 && rect.height > 0 && button.contains(hit) ? frames + 1 : 0;
              if (frames >= 2) {
                const ready = document.createElement('div'); ready.id = 'qa-host-switch-ready';
                ready.style.cssText = 'position:fixed;top:0;right:0;z-index:99999;font:10px monospace;background:white;color:black';
                ready.textContent = 'QA host switch ready'; document.body.append(ready);
              } else if (performance.now() < deadline) requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          }, true);
          window.addEventListener('yaKeyboardShown', () => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              let ready=document.getElementById('qa-keyboard-ready');
              if (!ready) { ready=document.createElement('div');ready.id='qa-keyboard-ready';ready.style.cssText='position:fixed;top:12px;right:0;z-index:99999;font:10px monospace;background:white;color:black';document.body.append(ready); }
              ready.textContent='QA keyboard ready';
            }));
          });
          let count = 0, issued = 0, max = 0, maxKey = 0, domMax = 0, taskMax = 0, dropped = 0, stream = 0;
          new MutationObserver(records => {
            // beforeinput defines the edit interval. XCTest's separate literal
            // key calls can move DOM focus between keys; transcript mutations
            // in that interval still overlap the same real keyboard edit.
            if (issued > 0 && issued < 37 && records.some(record => (record.target.closest?.('[data-message-list]') || record.target.parentElement?.closest?.('[data-message-list]')))) stream++;
          }).observe(document, {subtree:true,childList:true,characterData:true});
          document.addEventListener('beforeinput', event => {
            const input = event.target;
            if (!input.matches?.('textarea[data-composer-input]')) return;
            const start = performance.now(), before = input.value, key = ++issued;
            input.addEventListener('input', () => { domMax = Math.max(domMax, performance.now()-start) }, {once:true});
            setTimeout(() => { taskMax = Math.max(taskMax, performance.now()-start) }, 0);
            requestAnimationFrame(() => {
              count++; const latency = performance.now()-start; if (latency>max) {max=latency;maxKey=key}
              if (input.value === before) dropped++;
              let report = document.getElementById('qa-input-metrics');
              if (!report) {
                report = document.createElement('div'); report.id = 'qa-input-metrics';
                report.style.cssText = 'position:fixed;top:0;right:0;z-index:99999;font:10px monospace;background:white;color:black';
                document.body.append(report);
              }
              report.textContent = `QA input=${count};max=${Math.ceil(max)};dropped=${dropped};key=${maxKey};dom=${Math.ceil(domMax)};task=${Math.ceil(taskMax)};stream=${stream}`;
            });
          }, true);
        })();
        """
      configuration.userContentController.addUserScript(
        WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
  }
#endif
