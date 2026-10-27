/**
 * dsh-restart-button — browser side.
 *
 * A restart button pinned to the top-right of the app frame. It renders into
 * `shell.overlay`, the slot the layout draws once for the whole frame, so the
 * button is there on the landing page and on an empty session list too — not
 * only once a conversation is open. It also keeps sitting where it is while
 * panels come and go, and disappears with the frame rather than leaking between
 * views.
 *
 * Everything here is deliberately self-contained: no dynamic import, no third
 * party runtime, styles as inline objects (the sandbox refuses remote scripts
 * and a linked stylesheet has nowhere to live), and no state the component
 * could not rebuild after a reload.
 *
 * What the button may do is decided by the host, not here: this half asks
 * `/status` what a click would cost and reports the answer. Deciding whether a
 * restart is safe, writing the record of what it interrupted, and doing the
 * restarting all belong to the host.
 *
 * Hand-built rather than bundled: one React component, no JSX, no dependency
 * beyond `react`, which the host already offers every client.
 */
window.__ModuleLoader__.load({
  /**
   * Must equal this package's name verbatim, scope included. The loader keys
   * its graph row by the package name; a bare id makes the row look
   * unregistered, the loader re-fetches the script, and the second execution
   * throws "duplicate factory registration" on web boot (0.6.0 shipped this).
   */
  id: '@yangluo-2021/dsh-restart-button',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    exports.name = 'dsh-restart-button'
    exports.inject = ['slots']

    var ROUTE = '/dsh-restart-button'

    /**
     * Absolute path for one of this plugin's own routes, following the page's
     * `baseURI`. Desktop serves its page under a custom protocol, so a bare
     * relative URL would resolve somewhere the host never answers.
     * @param {string} path - route starting with `/`.
     * @returns {string} the path to fetch.
     */
    function api(path) {
      var relative = path.replace(/^\/+/, '')
      if (typeof document === 'undefined') return '/' + relative
      return new URL(relative, document.baseURI).pathname
    }

    /** How often a visible button refreshes what a click would cost. */
    var POLL_MS = 8000
    /** Full path of one of this plugin's routes. */
    function endpoint(name) {
      return api(ROUTE + '/' + name)
    }

    /**
     * How far from the frame's top-right the button sits, in px.
     *
     * The inset clears Windows' own minimise/maximise/close group, which the app
     * does not draw and cannot be told to move; further left is wasted margin on
     * a frameless build, closer lands the button under the window controls.
     */
    var INSET_RIGHT = 148
    var INSET_TOP = 9

    // ------------------------------------------------------------------ words
    var ZH = {
      label: '重启 DeepSeek Harness',
      busyHint: '{n} 个会话正在运行',
      confirmTitle: '重启 DeepSeek Harness？',
      confirmIdle: '会话会被保存，整个客户端（包括后台 Host）会重新启动。',
      confirmBusy: '{n} 个会话正在运行，立即重启会中断它们；也可以等它们跑完后自动重启。会话记录会保留。',
      cancel: '取消',
      later: '跑完后重启',
      now: '立即重启',
      scheduled: '已安排在任务跑完后重启。',
      cancelScheduled: '取消重启',
      sending: '正在重启，应用即将关闭…',
      failed: '没能重启',
      unsupported: '当前运行方式不支持重启（仅支持 Windows 桌面版）。',
      close: '关闭',
      resumeTitle: '上次重启中断了 {n} 个会话',
      resumeText: '会话记录已保留，打开对应会话发送「继续」即可接着跑。',
      acknowledge: '知道了',
      poweredBy: '重启',
    }
    var EN = {
      label: 'Restart DeepSeek Harness',
      busyHint: '{n} session(s) running',
      confirmTitle: 'Restart DeepSeek Harness?',
      confirmIdle: 'Sessions are saved and the whole client (including the background Host) starts again.',
      confirmBusy: '{n} session(s) are running and a restart now interrupts them; you can also restart automatically once they finish. Session history is kept.',
      cancel: 'Cancel',
      later: 'Restart when done',
      now: 'Restart now',
      scheduled: 'Scheduled to restart once the running work finishes.',
      cancelScheduled: 'Cancel restart',
      sending: 'Restarting — the app is about to close…',
      failed: 'Restart failed',
      unsupported: 'Restart is only supported in the Windows desktop app.',
      close: 'Close',
      resumeTitle: '{n} session(s) were interrupted by the last restart',
      resumeText: 'Session history is kept; open one and send "continue" to carry on.',
      acknowledge: 'Got it',
      poweredBy: 'Restart',
    }

    var zh = false
    try {
      zh = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase().indexOf('zh') === 0
    } catch (error) {
      zh = false
    }
    var WORDS = zh ? ZH : EN

    function t(key, vars) {
      var text = WORDS[key] || key
      if (vars === undefined) return text
      return text.replace(/\{(\w+)\}/g, function (whole, name) {
        return vars[name] === undefined ? whole : String(vars[name])
      })
    }

    // ----------------------------------------------------------------- styles
    var SURFACE = {
      position: 'fixed',
      top: INSET_TOP + 'px',
      right: INSET_RIGHT + 'px',
      zIndex: 2147483000,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '6px',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: '12px',
      lineHeight: '1.45',
      WebkitAppRegion: 'no-drag',
    }

    var BUTTON = {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '28px',
      height: '28px',
      padding: 0,
      border: '1px solid rgba(255, 255, 255, 0.14)',
      borderRadius: '8px',
      background: 'rgba(47, 52, 58, 0.92)',
      color: '#e6e8ea',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.28)',
      transition: 'background 120ms ease, transform 120ms ease',
    }

    var BUTTON_BUSY = Object.assign({}, BUTTON, { cursor: 'progress', opacity: 0.8 })

    var DOT = {
      position: 'absolute',
      top: '3px',
      right: '3px',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: '#e0a24a',
      boxShadow: '0 0 0 2px rgba(47, 52, 58, 0.95)',
    }

    var CARD = {
      maxWidth: '272px',
      padding: '10px 12px',
      border: '1px solid rgba(255, 255, 255, 0.14)',
      borderRadius: '10px',
      background: 'rgba(32, 36, 41, 0.97)',
      color: '#e6e8ea',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.34)',
    }

    var TITLE = { margin: '0 0 6px', fontWeight: 600, fontSize: '12px' }
    var TEXT = { margin: '0 0 10px', opacity: 0.74, fontSize: '11px' }
    var TEXT_LAST = { margin: 0, opacity: 0.74, fontSize: '11px' }
    var ROW = { display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }

    function actionStyle(kind) {
      var primary = kind === 'primary'
      var danger = kind === 'danger'
      return {
        padding: '4px 10px',
        border: primary || danger ? '1px solid transparent' : '1px solid rgba(255, 255, 255, 0.16)',
        borderRadius: '6px',
        background: danger ? '#e0574a' : (primary ? 'rgba(224, 87, 74, 0.16)' : 'transparent'),
        color: danger ? '#ffffff' : (primary ? '#f0b0a8' : '#cfd3d7'),
        cursor: 'pointer',
        fontSize: '11px',
        fontFamily: 'inherit',
      }
    }

    /** The circular arrow, drawn as strokes so it takes the surrounding colour. */
    function RestartIcon(props) {
      var spinning = props !== null && typeof props === 'object' && props.spinning === true
      return h(
        'svg',
        {
          width: 15,
          height: 15,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: spinning ? { animation: 'dsh-restart-spin 900ms linear infinite' } : undefined,
        },
        h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
        h('path', { d: 'M21 3v6h-6' }),
      )
    }

    /**
     * One request, read as JSON, with the two shapes the callers care about:
     * a body with `ok`, or a sentence explaining why not.
     */
    function request(url, options) {
      var init = { cache: 'no-store' }
      if (options !== undefined) {
        if (options.method !== undefined) init.method = options.method
        if (options.body !== undefined) {
          init.method = 'POST'
          init.headers = { 'content-type': 'application/json' }
          init.body = JSON.stringify(options.body)
        }
      }
      return fetch(url, init).then(function (response) {
        return response
          .json()
          .catch(function () {
            return {}
          })
          .then(function (body) {
            if (response.ok && body.ok !== false) return body
            var failure = new Error(body.error || 'HTTP ' + response.status)
            failure.body = body
            throw failure
          })
      })
    }

    function storageGet(area, key) {
      try {
        return area === undefined ? null : area.getItem(key)
      } catch (error) {
        return null
      }
    }

    function storageSet(area, key, value) {
      try {
        if (area !== undefined) area.setItem(key, value)
      } catch (error) {
        /* a refused storage write only costs one repeated notice */
      }
    }

    /**
     * The button, and everything it opens.
     *
     * Every phase is reachable from every other one, so the card can never be
     * left with no way out. A successful restart never resolves — the process
     * serving the request stops answering — so `sending` is what the user sees
     * last.
     */
    function RestartButton() {
      var phaseState = react.useState('idle')
      var phase = phaseState[0]
      var setPhase = phaseState[1]

      var statusState = react.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]

      var noteState = react.useState('')
      var note = noteState[0]
      var setNote = noteState[1]

      var noticeState = react.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var root = react.useRef(null)
      var busy = status !== null && status.activeTasks === true
      var sessions = status !== null && Array.isArray(status.busySessions) ? status.busySessions.length : 0

      // A restart that happened while this page was open leaves a record; show
      // it once per record, then forget it in the host.
      react.useEffect(
        function () {
          var local = undefined
          try {
            local = window.localStorage
          } catch (error) {
            local = undefined
          }
          request(endpoint('status'))
            .then(function (body) {
              setStatus(body)
              var record = body.resume
              if (record === null || record === undefined) return
              var key = 'dsh-restart-button:resume:' + record.id
              if (storageGet(local, key) === 'shown') return
              storageSet(local, key, 'shown')
              setNotice(record)
            })
            .catch(function () {
              /* the button still works; the badge is a nicety */
            })
        },
        [],
      )

      // Refresh the badge while the page sits idle, so "3 sessions running" is
      // not a fact from ten minutes ago.
      react.useEffect(
        function () {
          if (phase !== 'idle' && phase !== 'confirm' && phase !== 'scheduled') return undefined
          var timer = setInterval(function () {
            request(endpoint('status'))
              .then(setStatus)
              .catch(function () {})
          }, POLL_MS)
          return function () {
            clearInterval(timer)
          }
        },
        [phase],
      )

      // Any click outside the widget closes whatever it opened.
      react.useEffect(
        function () {
          if (phase !== 'confirm' && notice === null) return undefined
          var onDown = function (event) {
            var node = root.current
            if (node !== null && !node.contains(event.target)) {
              if (phase === 'confirm') setPhase('idle')
              if (notice !== null) dismissNotice()
            }
          }
          var onKey = function (event) {
            if (event.key === 'Escape') {
              if (phase === 'confirm') setPhase('idle')
              if (notice !== null) dismissNotice()
            }
          }
          document.addEventListener('mousedown', onDown)
          document.addEventListener('keydown', onKey)
          return function () {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
          }
        },
        [phase, notice],
      )

      function dismissNotice() {
        var record = notice
        setNotice(null)
        if (record === null || record === undefined) return
        request(endpoint('resume-ack'), {
          body: { id: record.id },
        }).catch(function () {
          /* the record ages out on its own within ten minutes */
        })
      }

      function send(when) {
        setPhase('sending')
        setNote('')
        request(endpoint('restart'), { body: { when: when } })
          .then(function () {
            setPhase('sending')
          })
          .catch(function (error) {
            // A refusal carries a body and a sentence. A dropped connection has
            // no body at all, and that is what a restart in progress looks like
            // from this side: the host stopped answering on its way out.
            if (!error || error.body === undefined) {
              setPhase('sending')
              return
            }
            setNote(error instanceof Error ? error.message : String(error))
            setPhase('error')
          })
      }

      function open() {
        if (phase === 'confirm') {
          setPhase('idle')
          return
        }
        if (phase === 'sending') return
        setNote('')
        request(endpoint('status'))
          .then(function (body) {
            setStatus(body)
            if (body.supported === false) {
              setNote(t('unsupported'))
              setPhase('error')
              return
            }
            var policy = body.confirm || 'when-busy'
            var mustAsk = policy === 'always' || (policy === 'when-busy' && body.activeTasks === true)
            if (mustAsk) {
              setPhase('confirm')
              return
            }
            send('now')
          })
          .catch(function (error) {
            setNote(error instanceof Error ? error.message : String(error))
            setPhase('error')
          })
      }

      function schedule() {
        setPhase('scheduled')
        request(endpoint('restart'), { body: { when: 'idle' } }).catch(function (error) {
          setNote(error instanceof Error ? error.message : String(error))
          setPhase('error')
        })
      }

      function cancelSchedule() {
        request(endpoint('cancel'), { body: {} })
          .catch(function () {})
          .then(function () {
            setPhase('idle')
          })
      }

      var spinning = phase === 'sending'
      var children = []

      if (notice !== null) {
        var interrupted = Array.isArray(notice.interrupted) ? notice.interrupted.length : 0
        children.push(
          h(
            'div',
            { key: 'resume', style: CARD, role: 'status' },
            h('p', { style: TITLE }, t('resumeTitle', { n: interrupted })),
            h('p', { style: TEXT }, t('resumeText')),
            h(
              'div',
              { style: ROW },
              h('button', { type: 'button', style: actionStyle('plain'), onClick: dismissNotice }, t('acknowledge')),
            ),
          ),
        )
      }

      children.push(
        h(
          'button',
          {
            key: 'trigger',
            type: 'button',
            title: busy ? t('label') + ' — ' + t('busyHint', { n: sessions }) : t('label'),
            'aria-label': t('label'),
            style: spinning ? BUTTON_BUSY : BUTTON,
            onClick: open,
          },
          h(RestartIcon, { spinning: spinning }),
          busy && !spinning ? h('span', { style: DOT }) : null,
        ),
      )

      if (phase === 'confirm') {
        children.push(
          h(
            'div',
            { key: 'confirm', style: CARD, role: 'dialog', 'aria-label': t('confirmTitle') },
            h('p', { style: TITLE }, t('confirmTitle')),
            h('p', { style: TEXT }, busy ? t('confirmBusy', { n: sessions }) : t('confirmIdle')),
            h(
              'div',
              { style: ROW },
              h('button', { type: 'button', style: actionStyle('plain'), onClick: function () { setPhase('idle') } }, t('cancel')),
              busy
                ? h('button', { type: 'button', style: actionStyle('primary'), onClick: schedule }, t('later'))
                : null,
              h('button', { type: 'button', style: actionStyle('danger'), onClick: function () { send('now') } }, t('now')),
            ),
          ),
        )
      }

      if (phase === 'scheduled') {
        children.push(
          h(
            'div',
            { key: 'scheduled', style: CARD, role: 'status' },
            h('p', { style: TEXT_LAST }, t('scheduled')),
            h(
              'div',
              { style: Object.assign({}, ROW, { marginTop: '10px' }) },
              h('button', { type: 'button', style: actionStyle('plain'), onClick: cancelSchedule }, t('cancelScheduled')),
            ),
          ),
        )
      }

      if (phase === 'sending') {
        children.push(
          h(
            'div',
            { key: 'sending', style: CARD, role: 'status' },
            h('p', { style: TEXT_LAST }, t('sending')),
          ),
        )
      }

      if (phase === 'error') {
        children.push(
          h(
            'div',
            { key: 'error', style: CARD, role: 'alert' },
            h('p', { style: TITLE }, t('failed')),
            h('p', { style: TEXT }, note || t('unsupported')),
            h(
              'div',
              { style: ROW },
              h('button', { type: 'button', style: actionStyle('plain'), onClick: function () { setPhase('idle') } }, t('close')),
            ),
          ),
        )
      }

      var spinStyle = h('style', { key: 'spin' }, '@keyframes dsh-restart-spin{to{transform:rotate(360deg)}}')
      return h('div', { ref: root, style: SURFACE }, [spinStyle].concat(children))
    }

    /**
     * Register the button against the frame-wide overlay slot.
     * @param {object} ctx - the client context carrying `slots`.
     */
    exports.apply = function apply(ctx) {
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-restart-button' },
          RestartButton,
        )
      })
    }

    return module.exports
  },
})
