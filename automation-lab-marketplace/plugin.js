import {
  atom,
  Badge,
  Button,
  ErrorState,
  Input,
  Loader,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  STATUSBAR_AREAS,
  Tabs,
  TabsList,
  TabsTrigger,
  host,
  useMutation,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'automation-lab-marketplace'
const GITHUB_DEVICE_URL = 'https://github.com/login/device'
const key = (...parts) => [ID, ...parts]
const currentScope = () => JSON.stringify([host.state.connectionId.get(), host.state.profile.get()])

// Release engineering replaces this only in a reviewed immutable launcher artifact.
// Never populated from storage, RPC, query strings or user-entered repository URLs.
const BOOTSTRAP_RELEASE = {"source": "https://github.com/Carl-Taylor-Automation-Lab/automation-lab-hermes-marketplace.git", "revision": "06e7ff818542967b577dbc47af12808a95037ad4"}

async function nativeCli(active, gateway, profile, argv, timeoutMs = 240_000) {
  if (!active() || !gateway || host.getGateway() !== gateway) throw new Error('Backend/profile changed; reopen the marketplace')
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile) || ['all', 'current'].includes(profile.toLowerCase())) throw new Error('An explicit profile is required')
  const timeout = Math.min(600, Math.ceil(timeoutMs / 1000))
  const result = await gateway.request('cli.exec', { argv: ['-p', profile, ...argv], timeout }, timeout * 1000 + 15_000)
  if (!active() || host.getGateway() !== gateway) throw new Error('Backend/profile changed; discarded old response')
  if (result?.blocked || result?.code !== 0) throw new Error('Native command failed or was denied. Nothing will be retried automatically.')
  return result.output
}

async function scopedRest(ctx, active, scope, target, path, options = {}, gateway = host.getGateway()) {
  if (!active() || !gateway || host.getGateway() !== gateway) throw new Error('Backend/profile changed; reopen the marketplace')
  const profile = JSON.parse(scope)[1]
  if (path === '/state') {
    const inventory = await gateway.request('plugins.manage', { action: 'list', profile })
    if (!active() || host.getGateway() !== gateway) throw new Error('Backend/profile changed; discarded old response')
    if (!Array.isArray(inventory?.plugins)) throw new Error('Native plugin inventory unavailable')
    const installed = inventory.plugins.find(row => row.name === ID && row.source !== 'bundled')
    if (!installed || installed.status !== 'enabled') {
      const error = new Error(installed ? 'Marketplace Agent component is disabled; enable the reviewed installation in Agent Plugins.' : 'Marketplace Agent component is not installed on this agent.')
      error.setupRequired = !installed
      throw error
    }
  } else if (!target || target.profile !== profile) throw new Error('Installation destination is unconfirmed')
  const output = await nativeCli(active, gateway, profile, ['automation-lab', path.slice(1), '--profile-name', profile,
    '--request', JSON.stringify({ ...options.body, ...(target ? { expected_target: target.id } : {}) })], options.timeoutMs)
  const lines = output.split('\n').filter(line => line.startsWith('AUTOMATION_LAB_JSON:'))
  if (lines.length !== 1) throw new Error('Marketplace CLI is incompatible; install the reviewed Agent release')
  const envelope = JSON.parse(lines[0].slice('AUTOMATION_LAB_JSON:'.length))
  if (!envelope.ok) throw new Error(envelope.error || 'Marketplace operation failed')
  const result = envelope.result
  if (result?.target?.protocol !== 1 || !result?.target?.id || result.target.profile !== profile || (target && result.target.id !== target.id)) {
    throw new Error('Backend cannot confirm the selected installation destination; reopen the marketplace')
  }
  return result
}

async function setupAgent(ctx, active, scope, gateway) {
  const release = BOOTSTRAP_RELEASE
  if (!release || !/^[0-9a-f]{40}$/.test(release.revision)) throw new Error('Publication gate: no reviewed immutable release is configured')
  const profile = JSON.parse(scope)[1]
  await nativeCli(active, gateway, profile, ['plugins', 'install', release.source, '--ref', release.revision, '--no-enable'])
  // Stock exact-ref installer verifies the detached commit and writes pinned
  // provenance before returning. Never force past scanner/collision refusal.
  await nativeCli(active, gateway, profile, ['plugins', 'enable', ID])
  const state = await scopedRest(ctx, active, scope, null, '/state', {}, gateway)
  if (!state.backend?.enabled || !state.backend.pinned || state.backend.revision !== release.revision || state.backend.source !== release.source) {
    throw new Error('Setup provenance did not match the reviewed release; do not connect GitHub')
  }
  return state
}

function createPage(ctx, scopeState, refreshScope) {
  function MarketplacePage({ scope, initialTab }) {
    const [connection, profile] = JSON.parse(scope)
    const alive = useRef(true)
    useEffect(() => {
      alive.current = true
      return () => { alive.current = false }
    }, [])
    const active = () => alive.current && scopeState.get() === scope && currentScope() === JSON.stringify([connection, profile]) && host.getGateway() === gateway
    const target = useRef(null)
    const gateway = useRef(host.getGateway()).current
    const rest = (path, options) => scopedRest(ctx, active, scope, target.current, path, options, gateway)
    const queryClient = useQueryClient()
    const [search, setSearch] = useState('')
    const [flow, setFlow] = useState(null)
    const [copyStatus, setCopyStatus] = useState('idle')
    const copyPending = useRef(false)
    const liveFlow = useRef(null)
    liveFlow.current = flow
    const [tab, setTab] = useState(initialTab || null)
    const [marketplace, setMarketplace] = useState('all')
    const installPending = useRef(false)
    const [review, setReview] = useState(null)
    const [removal, setRemoval] = useState(null)
    const [restartNotice, setRestartNotice] = useState(null)

    const state = useQuery({
      queryKey: key('state', scope),
      queryFn: () => rest('/state'),
      retry: false
    })
    if (!target.current && !state.isError) target.current = state.data?.target
    // ponytail: a reminder, not a readiness probe. Only the user dismisses it.
    // Include the server-issued destination ID: identical paths on two agents differ.
    const restartKey = target.current ? `restart:${JSON.stringify([connection, profile, target.current.id])}` : null
    const restartNeeded = restartNotice ?? (restartKey ? ctx.storage.get(restartKey, null) : null)
    const rememberRestart = kind => {
      if (!active() || !restartKey) return
      ctx.storage.set(restartKey, kind)
      setRestartNotice(kind)
    }
    const destinationName = useQuery({
      queryKey: key('connection-label', scope), retry: false,
      queryFn: async () => {
        if (connection === 'local') return 'Local'
        const rows = await host.connections()
        if (!active()) throw new Error('Connection changed')
        return rows.find(row => row.id === connection)?.label || 'Connection name unavailable'
      }
    })
    const destination = `${destinationName.data || 'Connection name unavailable'} → ${target.current?.profile || 'destination unavailable'}`
    const catalog = useQuery({
      queryKey: key('catalog', scope, target.current?.id),
      staleTime: 3_600_000,
      refetchOnWindowFocus: false,
      queryFn: () => rest('/catalog', { timeoutMs: 120_000 }),
      enabled: !state.isError && state.data?.connected === true && !!target.current,
      retry: false
    })
    const openGitHub = async () => {
      if (!active()) return
      // ponytail: the SDK uses native IPC; window.open is denied by Electron.
      if (!await ctx.os.openExternal(GITHUB_DEVICE_URL) && active()) {
        host.notify({ kind: 'error', message: 'Could not open your browser. Open https://github.com/login/device manually and enter the code shown here.' })
      }
    }
    const copyCode = async () => {
      if (!active() || !flow || liveFlow.current !== flow || copyPending.current) return
      copyPending.current = true
      setCopyStatus('pending')
      try {
        const copied = await ctx.os.writeClipboard(flow.user_code)
        if (active() && liveFlow.current === flow) setCopyStatus(copied === true ? 'copied' : 'failed')
      } catch {
        if (active() && liveFlow.current === flow) setCopyStatus('failed')
      } finally {
        copyPending.current = false
      }
    }
    const startAuth = useMutation({
      mutationFn: () => rest('/auth/start', { method: 'POST' }),
      onSuccess: next => {
        if (!active()) return
        setCopyStatus('idle')
        setFlow(next)
      },
      onError: error => active() && host.notify({ kind: 'error', message: error instanceof Error ? error.message : 'Could not start GitHub connection' })
    })
    const disconnect = useMutation({
      mutationFn: () => rest('/logout', { method: 'POST' }),
      onSuccess: async () => {
        if (!active()) return
        setFlow(null)
        await queryClient.invalidateQueries({ queryKey: key('state', scope) })
        queryClient.removeQueries({ queryKey: key('catalog', scope) })
      }
    })
    const install = useMutation({
      mutationFn: ({ name, marketplace, reviewed_revision }) =>
        rest('/install', {
          method: 'POST',
          body: { name, marketplace, reviewed_revision, enable: true },
          timeoutMs: 700_000
        }),
      onSuccess: (result, item) => {
        if (!active()) return
        if (result.review_required) { setReview(result); return }
        setReview(null)
        const previous = catalog.data?.plugins.find(row => row.name === item.name && row.marketplace === item.marketplace)
        const staysDisabled = previous?.installed && !previous.enabled
        if (result.restart_required) rememberRestart(staysDisabled ? 'changes' : 'skills')
        host.notify({ kind: 'success', message: `${result.name} ${result.version} installed.${staysDisabled ? ' This plugin stays disabled.' : result.restart_required ? ' Restart this agent to use its new skills.' : ''}` })
        void queryClient.invalidateQueries({ queryKey: key('catalog', scope) })
      },
      onError: error => active() && host.notify({ kind: 'error', message: error instanceof Error ? error.message : 'Install failed' }),
      onSettled: () => { installPending.current = false }
    })
    const installPackage = item => {
      if (!active() || installPending.current || remove.isPending || toggle.isPending) return
      // ponytail: one manual install at a time, matching the backend lock.
      installPending.current = true
      install.mutate(item)
    }

    const remove = useMutation({
      mutationFn: item => rest('/uninstall', { method: 'POST', body: { name: item.name, marketplace: item.marketplace, confirm_name: item.name } }),
      onSuccess: () => {
        if (!active()) return
        setRemoval(null)
        rememberRestart('changes')
        void queryClient.invalidateQueries({ queryKey: key('catalog', scope) })
      },
      onError: error => active() && host.notify({ kind: 'error', message: error.message })
    })
    const toggle = useMutation({
      mutationFn: item => rest('/enabled', { method: 'POST', body: { name: item.name, enabled: !item.enabled } }),
      onSuccess: (result, item) => {
        if (!active()) return
        if (result.restart_required) rememberRestart(item.enabled ? 'changes' : 'skills')
        void catalog.refetch()
      },
      onError: error => active() && host.notify({ kind: 'error', message: error.message })
    })
    useEffect(() => {
      if (!flow) return undefined
      let stopped = false
      let timer
      const poll = async () => {
        try {
          const result = await rest('/auth/poll', {
            method: 'POST',
            body: { flow_id: flow.flow_id }
          })
          if (stopped || !active()) return
          if (result.status === 'connected') {
            setFlow(null)
            await queryClient.invalidateQueries({ queryKey: key('state', scope) })
            if (active()) host.notify({ kind: 'success', message: `Connected to GitHub as ${result.username}` })
            return
          }
          timer = window.setTimeout(poll, Math.max(1, result.retry_after || flow.interval) * 1000)
        } catch (error) {
          if (!stopped && active()) {
            setFlow(null)
            host.notify({ kind: 'error', message: error instanceof Error ? error.message : 'GitHub connection failed' })
          }
        }
      }
      timer = window.setTimeout(poll, flow.interval * 1000)
      return () => {
        stopped = true
        window.clearTimeout(timer)
      }
    }, [connection, ctx, flow, profile, queryClient])

    const setupPending = useRef(false)
    const setup = useMutation({
      mutationFn: () => setupAgent(ctx, active, scope, gateway),
      onSuccess: result => {
        if (!active()) return
        target.current = result.target
        queryClient.setQueryData(key('state', scope), result)
      },
      onError: error => { if (active()) host.notify({ kind: 'error', message: error.message }) },
      onSettled: () => { setupPending.current = false }
    })
    const plugins = catalog.isError ? [] : catalog.data?.plugins || []
    useEffect(() => {
      if (catalog.data && tab === null) setTab(plugins.some(item => item.installed) ? 'installed' : 'browse')
    }, [catalog.data, tab])
    const selectedTab = tab || (plugins.some(item => item.installed) ? 'installed' : 'browse')
    const groups = useMemo(() => {
      const needle = search.trim().toLowerCase()
      const matches = (catalog.isError ? [] : catalog.data?.plugins || []).filter(item =>
        (marketplace === 'all' || item.marketplace === marketplace) &&
        `${item.name} ${item.display_name} ${item.description}`.toLowerCase().includes(needle))
      return {
        browse: matches.filter(item => !item.installed),
        installed: matches.filter(item => item.installed),
        updates: matches.filter(item => item.installed && item.update_available)
      }
    }, [catalog.data, catalog.isError, search, marketplace])
    const rows = groups[selectedTab]
    const marketplaces = [...new Map(plugins.map(item => [item.marketplace, item.marketplace_label])).entries()]

    if (state.isLoading) return jsx(Loader, { type: 'lemniscate-bloom' })
    if (state.isError) {
      const error = setup.error || state.error
      const message = error instanceof Error ? error.message : 'Backend connection failed'
      const missing = state.error?.setupRequired === true && !setup.isError
      const selectedTarget = jsx('p', {
        className: 'rounded-md border border-(--ui-stroke-secondary) px-4 py-3 text-sm',
        style: { overflowWrap: 'anywhere' },
        children: `Selected agent: ${destinationName.data || 'Connection name unavailable'} → Profile: ${profile}`
      })
      // ponytail: native details gives keyboard-accessible disclosure without extra state.
      const details = jsxs('details', { className: 'text-sm text-(--ui-text-secondary)', children: [
        jsx('summary', { className: 'cursor-pointer py-3', children: 'Setup details' }),
        missing ? jsxs('div', { className: 'space-y-2', style: { overflowWrap: 'anywhere' }, children: [
          jsx('p', { children: 'Setup installs and enables the Automation Lab Agent component in the selected profile. No agent restart is needed.' }),
          jsx('p', { children: 'This uses your administrator access to the agent. Profiles keep settings separate; they do not limit OS permissions.' }),
          BOOTSTRAP_RELEASE ? jsxs('div', { children: [
            jsx('p', { children: `Source: ${BOOTSTRAP_RELEASE.source}` }),
            jsx('p', { children: `Exact revision: ${BOOTSTRAP_RELEASE.revision}` })
          ] }) : null
        ] }) : jsx('p', { style: { overflowWrap: 'anywhere' }, children: message })
      ] })
      if (missing) return jsx('main', { className: 'h-full overflow-y-auto p-6', children:
        jsxs('section', { 'aria-label': 'Set up Automation Lab', className: 'mx-auto max-w-xl rounded-lg border border-(--ui-stroke-secondary) p-6', children: [
          jsx('h2', { className: 'text-lg font-semibold', children: 'Let’s get you set up' }),
          jsx('p', { className: 'mt-2 mb-4 text-sm text-(--ui-text-secondary)', children: 'Set up Automation Lab to add plugins to this agent.' }),
          selectedTarget,
          jsx('ol', { 'aria-label': 'Setup steps', className: 'my-6 space-y-4', children: [
            ['Set up this agent', null],
            ['Sign in to GitHub', 'So we can check which plugins you can use.'],
            ['Pick your plugins', null]
          ].map(([label, why], index) => jsxs('li', { className: 'flex items-start gap-3', children: [
            jsx('span', { 'aria-hidden': true, className: 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-(--ui-stroke-secondary) text-xs', children: index + 1 }),
            jsxs('div', { children: [jsx('p', { className: 'text-sm font-medium', children: label }),
              why ? jsx('p', { className: 'mt-1 text-sm text-(--ui-text-secondary)', children: why }) : null] })
          ] }, label)) }),
          jsx(Button, { disabled: !BOOTSTRAP_RELEASE || setup.isPending,
            onClick: () => { if (active() && !setupPending.current) { setupPending.current = true; setup.mutate() } },
            children: setup.isPending ? 'Setting up Automation Lab…' : 'Set up Automation Lab' }),
          jsx('p', { role: 'status', className: 'mt-2 text-sm text-(--ui-text-secondary)', children: setup.isPending
            ? 'Setting up the selected agent. You can sign in to GitHub after setup finishes.'
            : !BOOTSTRAP_RELEASE ? 'Setup is not available yet. A reviewed release is needed before we can continue.' : '' }),
          details
        ] })
      })
      const auth = /\b401\b|unauthorized/i.test(message)
      const denied = /\b403\b|denied|forbidden/i.test(message) && !message.includes('failed or was denied')
      const network = /network|timed? out|fetch|offline/i.test(message)
      return jsx(ErrorState, {
        title: auth ? 'Sign in to your agent again' : denied ? 'The agent could not allow this step' : network ? 'We couldn’t reach your agent' : setup.isError ? 'Setup could not finish' : 'Installation destination unavailable',
        description: auth ? 'Your agent sign-in needs attention. Reconnect to the agent, then check again.'
          : denied ? 'Check your access with the agent’s owner. Nothing will be retried automatically.'
          : network ? 'Check your connection, then try the destination check again.'
          : 'Check the selected agent and profile before continuing. Open Setup details for the reason. Nothing will be retried automatically.',
        children: jsxs('div', { className: 'space-y-3 text-left', children: [
          selectedTarget, details,
          jsx(Button, { disabled: setup.isPending, onClick: () => { if (active()) refreshScope() }, children: 'Retry destination check' })
        ] })
      })
    }

    return jsxs('div', {
      className: 'flex h-full flex-col overflow-hidden',
      children: [
        jsxs('header', {
          className: 'flex shrink-0 items-center justify-between gap-4 border-b border-(--ui-stroke-secondary) px-6 py-4',
          children: [
            jsxs('div', {
              children: [
                state.data?.connected ? jsx('h1', { className: 'text-lg font-semibold', children: 'Automation Lab Marketplace' }) : null,
                jsx('p', {
                  className: 'mt-1 text-sm text-(--ui-text-tertiary)',
                  style: { overflowWrap: 'anywhere' },
                  children: `Installing to: ${destination}`
                })
              ]
            }),
            state.data?.connected
              ? jsxs('div', {
                  className: 'flex items-center gap-2',
                  children: [
                    jsx(Badge, { children: `GitHub: ${state.data.username || 'connected'}` }),
                    jsx(Button, {
                      variant: 'ghost',
                      disabled: disconnect.isPending,
                      onClick: () => disconnect.mutate(),
                      children: 'Disconnect'
                    })
                  ]
                })
              : null
          ]
        }),
        restartNeeded
          ? jsxs('section', {
              'aria-label': 'Agent restart reminder',
              className: 'shrink-0 space-y-2 border-b border-(--ui-stroke-secondary) px-6 py-3 text-sm',
              children: [
                jsx('p', { role: 'status', children: restartNeeded === 'skills'
                  ? 'Installed. Restart this agent to use its new skills.'
                  : 'Plugin changes saved. Restart this agent to apply them. Disabled plugins stay off.' }),
                jsx('p', { children: `Agent: ${destination}` }),
                jsx('p', { children: 'Restart the agent shown above, not just this window or a new chat. Wait for its work to finish first.' }),
                jsxs('details', { children: [
                  jsx('summary', { className: 'cursor-pointer', children: 'How to restart' }),
                  jsx('p', { children: 'For a Cloud agent, use Restart for that agent in Hermes Cloud. For a local agent managed by Desktop, quit and reopen Hermes. If its agent or gateway runs independently, ask its owner to restart that process too; closing Desktop will not stop it. For a remote server, ask its owner to restart the process serving this agent and profile. A messaging gateway restart alone may not restart the Desktop agent.' }),
                  jsx('p', { children: 'Then start a new chat and ask the agent to list its skills. This reminder does not check whether skills are ready. Hide it after you have checked; hiding it does not restart anything.' })
                ] }),
                jsx(Button, { variant: 'ghost', onClick: () => {
                  if (!active() || !restartKey) return
                  ctx.storage.remove(restartKey)
                  setRestartNotice(false)
                }, children: 'Hide reminder' })
              ]
            })
          : null,
        !state.data?.configured
          ? jsx(ErrorState, {
              title: 'Sign-in is not ready yet',
              description: 'Ask the person who manages Automation Lab to finish setting up GitHub sign-in.'
            })
          : !state.data?.connected
            ? jsx('div', {
                className: 'min-h-0 flex-1 overflow-y-auto p-6',
                children: flow
                  ? jsxs('div', {
                      className: 'mx-auto max-w-xl rounded-lg border border-(--ui-stroke-secondary) p-6',
                      children: [
                        jsx('h2', { className: 'text-lg font-semibold', children: 'Finish signing in' }),
                        jsxs('ol', { className: 'mt-4 space-y-4 text-left', children: [
                          jsxs('li', { children: [
                            jsx('h3', { className: 'font-medium', children: '1. Copy code' }),
                            jsx('div', { className: 'my-2 select-text rounded-md border border-(--ui-stroke-secondary) p-4 font-mono text-xl tracking-widest', children: flow.user_code }),
                            jsx(Button, { disabled: copyStatus === 'pending', onClick: () => void copyCode(),
                              children: copyStatus === 'pending' ? 'Copying…' : copyStatus === 'copied' ? 'Copied' : 'Copy code' }),
                            jsx('p', { role: 'status', className: 'mt-2 text-sm', children:
                              copyStatus === 'failed' ? 'Could not copy. Select the code above and copy it manually, or try again.' :
                              copyStatus === 'copied' ? 'Code copied to clipboard.' : '' })
                          ] }),
                          jsxs('li', { children: [
                            jsx('h3', { className: 'font-medium', children: '2. Open GitHub and paste code' }),
                            jsx(Button, { asChild: true, variant: 'link', children: jsx('a', {
                              href: GITHUB_DEVICE_URL,
                              onClick: event => { event.preventDefault(); void openGitHub() },
                              children: 'Open GitHub'
                            }) }),
                            jsx('p', { className: 'text-xs text-(--ui-text-tertiary)', children: GITHUB_DEVICE_URL })
                          ] }),
                          jsxs('li', { children: [
                            jsx('h3', { className: 'font-medium', children: '3. Return here' }),
                            jsx('p', { role: 'status', className: 'mt-2 text-sm text-(--ui-text-tertiary)', children: 'Waiting for you to finish on GitHub. Your plugins will appear here when you’re done.' })
                          ] })
                        ] })
                      ]
                    })
                  : jsxs('div', {
                      className: 'mx-auto max-w-xl rounded-lg border border-(--ui-stroke-secondary) p-6',
                      children: [
                        jsx('h2', { className: 'text-lg font-semibold', children: 'See your plugins' }),
                        jsx('p', { className: 'mt-2 text-sm text-(--ui-text-secondary)', children: 'Sign in with GitHub so we can show the plugins you can use.' }),
                        jsx('p', { className: 'my-4 text-sm text-(--ui-text-secondary)', children: 'First, get a code. Then copy it and open GitHub to sign in.' }),
                        jsx(Button, {
                          disabled: startAuth.isPending,
                          onClick: () => startAuth.mutate(),
                          children: startAuth.isPending ? 'Getting your code…' : 'Connect GitHub'
                        }),
                        jsx('p', { role: 'status', className: 'mt-2 text-sm text-(--ui-text-secondary)', children: startAuth.isPending ? 'Getting a sign-in code from GitHub.' : '' }),
                        jsxs('details', { className: 'text-sm text-(--ui-text-secondary)', children: [
                          jsx('summary', { className: 'cursor-pointer py-3', children: 'Connection details' }),
                          jsx('p', { children: 'GitHub access and installed plugins are saved on the selected agent and profile above. This uses administrator access to the agent; profiles do not limit OS permissions.' })
                        ] })
                      ]
                    })
              })
            : jsxs('main', {
                className: 'flex min-h-0 flex-1 flex-col gap-4 p-6',
                children: [
                  removal ? jsxs('section', { role: 'region', 'aria-label': 'Confirm uninstall', children: [
                    jsx('h2', { children: `Uninstall ${removal.name} from ${destination}?` }),
                    jsx('p', { children: 'Disable keeps the package installed. Uninstall removes its entire package folder and install record. Separate user skills, memories and plugin data are kept. Files edited inside the package folder will be removed. Restart afterward to unload running code.' }),
                    jsx(Button, { disabled: remove.isPending || install.isPending || toggle.isPending, onClick: () => { if (active()) remove.mutate(removal) }, children: `Confirm uninstall ${removal.name} from ${destination}` }),
                    jsx(Button, { variant: 'ghost', disabled: remove.isPending, onClick: () => setRemoval(null), children: 'Cancel uninstall' })
                  ] }) : null,
                  review ? jsxs('section', { role: 'region', 'aria-label': 'Plugin security review', children: [
                    jsx('h2', { children: `Review ${review.name} before installing` }),
                    jsx('pre', { className: 'max-h-64 overflow-auto whitespace-pre-wrap text-xs', children: review.report }),
                    jsx('p', { children: 'Only continue if you trust this exact revision. Dangerous findings cannot be overridden.' }),
                    jsx(Button, { disabled: install.isPending, onClick: () => installPackage({
                      name: review.name, marketplace: review.marketplace, reviewed_revision: review.revision
                    }), children: install.isPending ? 'Installing…' : 'I reviewed the findings — install this revision' }),
                    jsx(Button, { variant: 'ghost', onClick: () => setReview(null), children: 'Cancel' })
                  ] }) : null,
                  jsxs(Tabs, { value: selectedTab, onValueChange: setTab, children: [
                    jsx(TabsList, { 'aria-label': 'Plugin views', children: Object.entries({ browse: 'Browse', installed: 'Installed', updates: 'Updates' }).map(([value, label]) =>
                      jsx(TabsTrigger, { value, id: `marketplace-tab-${value}`, 'aria-controls': 'marketplace-results', children: `${label} (${catalog.isError || !catalog.data ? '?' : groups[value].length})` }, value)) })
                  ] }),
                  jsxs('label', { className: 'flex items-center gap-2 text-sm', children: [
                    'Marketplace',
                    jsx('select', { 'aria-label': 'Marketplace', value: marketplace, onChange: event => setMarketplace(event.target.value),
                      children: [jsx('option', { value: 'all', children: 'All marketplaces' }),
                        ...marketplaces.map(([value, label]) => jsx('option', { value, children: label }, value))] })
                  ] }),
                  install.isPending ? jsx('p', { role: 'status', children: `Installing ${install.variables?.name} from ${install.variables?.marketplace}… This may take a little while.` }) : null,
                  jsx(Input, {
                    value: search,
                    onChange: event => setSearch(event.target.value),
                    placeholder: 'Search plugins…',
                    'aria-label': 'Search Automation Lab plugins'
                  }),
                  catalog.isLoading
                    ? jsx(Loader, { type: 'lemniscate-bloom' })
                    : catalog.isError
                      ? jsx(ErrorState, {
                          title: 'Could not load the marketplace',
                          description: catalog.error instanceof Error ? catalog.error.message : 'Try again.',
                          children: jsxs('div', {
                            className: 'flex gap-2',
                            children: [
                              jsx(Button, { onClick: () => void catalog.refetch(), children: 'Try again' }),
                              jsx(Button, { variant: 'ghost', onClick: () => disconnect.mutate(), children: 'Reconnect GitHub' })
                            ]
                          })
                        })
                      : jsxs('div', {
                          role: 'tabpanel', id: 'marketplace-results', 'aria-labelledby': `marketplace-tab-${selectedTab}`, tabIndex: 0,
                          className: 'grid min-h-0 flex-1 auto-rows-max grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 overflow-y-auto',
                          children: [!rows.length ? jsx('p', { role: 'status', children:
                            search.trim() || marketplace !== 'all'
                              ? 'No plugins match these filters in this tab. Try another tab or clear your search and marketplace filter.'
                              : !plugins.length ? 'No plugins are available to this GitHub account. Only marketplaces you have access to are shown.'
                                : { browse: 'You’ve installed all available plugins. Manage them in Installed.', installed: 'No plugins installed yet. Find your first plugin in Browse.', updates: 'All up to date. No plugin updates are available.' }[selectedTab]
                          }) : null, ...rows.map(item =>
                            jsxs('article', {
                              className: 'flex flex-col rounded-lg border border-(--ui-stroke-secondary) p-4',
                              children: [
                                jsxs('div', {
                                  className: 'flex items-start justify-between gap-3',
                                  children: [
                                    jsx('h2', { className: 'font-medium', children: item.display_name }),
                                    jsx(Badge, { children: item.version || 'latest' })
                                  ]
                                }),
                                jsx('p', {
                                  className: 'mt-2 line-clamp-3 text-sm text-(--ui-text-tertiary)',
                                  children: item.description
                                }),
                                jsx('p', {
                                  className: 'mt-3 text-xs text-(--ui-text-quaternary)',
                                  children: `${item.marketplace_label} · ${item.skills} skills · ${item.connectors} connectors`
                                }),
                                item.installed ? jsx('p', { className: 'mt-2 text-sm', children: `Installed ${item.installed_version || 'version unknown'} · ${item.enabled ? 'Enabled' : 'Disabled'}` }) : null,
                                item.installed ? jsx('p', { className: 'mt-2 text-xs text-(--ui-text-secondary)', children: item.enabled
                                  ? 'If you installed, updated or enabled this plugin since the agent last started, restart that agent, then start a new chat to use its skills.'
                                  : 'This plugin is off. Updating or restarting does not turn it on. After Enable, restart this agent to use its skills.' }) : null,
                                item.installed && !item.source_conflict ? jsx(Button, {
                                  variant: 'ghost', disabled: toggle.isPending || install.isPending || remove.isPending,
                                  onClick: () => toggle.mutate(item), children: item.enabled ? 'Disable' : 'Enable'
                                }) : null,
                                item.installed && !item.source_conflict && item.name !== ID ? jsx(Button, {
                                  variant: 'ghost', disabled: toggle.isPending || install.isPending || remove.isPending,
                                  onClick: () => { if (active()) setRemoval(item) }, children: 'Uninstall'
                                }) : null,
                                jsx('div', {
                                  className: 'mt-auto pt-4',
                                  children: jsx(Button, {
                                    disabled: install.isPending || remove.isPending || toggle.isPending || (item.installed && !item.update_available),
                                    onClick: () => installPackage({ name: item.name, marketplace: item.marketplace }),
                                    children: install.isPending && install.variables?.name === item.name && install.variables?.marketplace === item.marketplace
                                      ? 'Installing…'
                                      : item.source_conflict
                                        ? 'Different source'
                                        : item.downgrade_blocked
                                          ? 'Installed newer'
                                          : item.update_available
                                            ? 'Update'
                                            : item.installed
                                              ? 'Installed'
                                              : 'Install'
                                  })
                                })
                              ]
                            },
                            `${item.marketplace}:${item.name}`)
                          )]
                        })
                ]
              })
      ]
    })
  }
  return function ScopedMarketplace({ initialTab }) {
    const scope = useValue(scopeState)
    return jsx(MarketplacePage, { scope, initialTab }, scope)
  }
}

export default {
  id: ID,
  name: 'Automation Lab Marketplace',
  defaultEnabled: false,
  register(ctx) {
    let generation = Date.now()
    const scopeState = atom(JSON.stringify([...JSON.parse(currentScope()), generation]))
    const changed = () => scopeState.set(JSON.stringify([...JSON.parse(currentScope()), ++generation]))
    ctx.onDispose(host.state.connectionId.listen(changed))
    ctx.onDispose(host.state.profile.listen(changed))
    const MarketplacePage = createPage(ctx, scopeState, changed)
    function Launcher({ scope }) {
      const [connection, profile] = JSON.parse(scope)
      const [initialTab, setInitialTab] = useState(null)
      const opener = useRef(null)
      const mainTrigger = useRef(null)
      const alive = useRef(true)
      useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
      const active = () => alive.current && scopeState.get() === scope && currentScope() === JSON.stringify([connection, profile]) && host.getGateway() === gateway
      const target = useRef(null)
      const gateway = useRef(host.getGateway()).current
    const rest = (path, options) => scopedRest(ctx, active, scope, target.current, path, options, gateway)
      // ponytail: share cache within a scope generation; switches always start fresh.
      const state = useQuery({ queryKey: key('state', scope), queryFn: () => rest('/state'),
        retry: false, staleTime: 3_600_000, refetchInterval: 3_600_000, refetchIntervalInBackground: true, refetchOnWindowFocus: false })
      if (!target.current && !state.isError) target.current = state.data?.target
      const catalog = useQuery({ queryKey: key('catalog', scope, target.current?.id),
        queryFn: () => rest('/catalog', { timeoutMs: 120_000 }), enabled: !state.isError && state.data?.connected === true && !!target.current,
        retry: false, staleTime: 3_600_000, refetchInterval: 3_600_000, refetchIntervalInBackground: true, refetchOnWindowFocus: false })
      const unknown = state.isError || !state.data?.target || !state.data?.connected || catalog.isError || !catalog.data
      const count = !unknown ? catalog.data.plugins.filter(item => item.installed && item.update_available).length : null
      return jsxs(Dialog, {
        children: [
          jsx(DialogTrigger, { asChild: true,
            children: jsx(Button, { ref: mainTrigger, variant: 'ghost', size: 'sm', onClick: event => { opener.current = event.currentTarget; setInitialTab(null) }, children: 'Automation Lab' }) }),
          count > 0 ? jsx(DialogTrigger, { asChild: true,
            children: jsx(Button, { variant: 'ghost', size: 'sm', style: { color: 'var(--ui-accent)' },
              'aria-label': `${count} updates available`, onClick: event => { opener.current = event.currentTarget; setInitialTab('updates') }, children: `+${count}` }) }) : null,
          unknown ? jsx('span', { role: 'status', 'aria-label': 'Update check unavailable', title: 'Updates unknown: checking, disconnected or unavailable. Open Automation Lab for details.', children: 'X' }) : null,
          jsxs(DialogContent, {
            onCloseAutoFocus: event => { event.preventDefault(); (opener.current?.isConnected ? opener.current : mainTrigger.current)?.focus() },
            style: { width: '92vw', maxWidth: '1100px' },
            bodyClassName: 'flex min-h-0 flex-col',
            children: [
              jsx(DialogTitle, { children: 'Automation Lab Marketplace' }),
              jsx(DialogDescription, { children: 'Browse and manage your marketplace plugins.' }),
              jsx('div', { style: { height: '65vh', minHeight: 0 }, children: jsx(MarketplacePage, { initialTab }) })
            ]
          })
        ]
      })
    }
    function ScopedLauncher() {
      const scope = useValue(scopeState)
      return jsx(Launcher, { scope }, scope)
    }
    // ponytail: native Dialog owns dismissal and focus; no route or extra pane.
    ctx.register({ id: 'launcher', area: STATUSBAR_AREAS.left, render: () => jsx(ScopedLauncher, {}) })
  }
}
