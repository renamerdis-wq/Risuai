//@name lorebook_toggle
//@display-name Lorebook Toggle
//@api 3.0
//@version 1.3.0
//@arg keep_blue int {{name::진입 버튼 파란색 그대로 두기}} {{checkbox::리수 기본 파란 버튼 유지}} 끄면(기본) 채팅 화면의 📕 버튼을 차분한 반투명 회색으로 바꿉니다. 이를 위해 시작할 때 메인 화면 접근 권한을 한 번 묻습니다.
//@link https://github.com/kwaroran/RisuAI RisuAI

/*
 * Lorebook Toggle
 *
 * 로어북 항목을 삭제하거나 키를 지우지 않고 켜고 끄는 플러그인.
 *
 * 동작 원리:
 *   RisuAI 로어북 엔진은 항목 내용 맨 위의 `@@dont_activate` 데코레이터를 읽으면
 *   키 매칭/상시활성 여부와 상관없이 그 항목을 비활성 처리한다.
 *   이 플러그인은 항목 내용의 데코레이터 블록 끝에
 *     `@@dont_activate lbtoggle`        (고정: 다시 켤 때까지 꺼짐)
 *     `@@dont_activate lbtoggle once`   (이번 턴만: 다음 메인/보조모델 요청 뒤 자동 복구)
 *     `@@lbtoggle sub_off`              (보조모델만: 메인 채팅엔 포함, 보조모델 요청에서만 제거)
 *   한 줄을 끼워넣거나 빼는 것만으로 토글한다.
 *   키, 보조키, 삽입 순서, 상시활성, 폴더 등 원래 설정은 전혀 건드리지 않는다.
 *   상태가 항목 내용 자체에 들어있으므로 별도 저장소 없이 세이브 파일과 함께 동기화된다.
 *
 * 대상:
 *   - 캐릭터 로어북 (globalLore)
 *   - 현재 채팅의 로컬 로어북 (localLore)
 *   - 로어북이 있는 모듈 (modules[].lorebook)
 */

(async () => {
    const MARK_BASE = '@@dont_activate lbtoggle';
    const MARK_HOLD = MARK_BASE;
    const MARK_ONCE = MARK_BASE + ' once';
    // 메인 채팅엔 그대로 들어가고, 보조모델 요청에서만 걷어내는 항목 표시.
    // 엔진이 모르는 데코레이터라 프롬프트에서는 그냥 제거된다.
    const MARK_SUB = '@@lbtoggle sub_off';
    const BUTTON_ID = 'lbtoggle-open';

    // ---------------------------------------------------------------
    // 마커 처리
    // ---------------------------------------------------------------

    /** 내용 맨 위의 연속된 데코레이터 줄 수 */
    function decoratorBlockLength(lines) {
        let n = 0;
        while (n < lines.length && lines[n].trimStart().startsWith('@@')) {
            n++;
        }
        return n;
    }

    function isMarkLine(line) {
        const t = line.trim();
        return t === MARK_HOLD || t === MARK_ONCE || t === MARK_SUB;
    }

    /** 'on' | 'hold' | 'once' | 'sub' */
    function getEntryState(entry) {
        const lines = String(entry?.content ?? '').trimStart().split('\n');
        const n = decoratorBlockLength(lines);
        for (let i = 0; i < n; i++) {
            const t = lines[i].trim();
            if (t === MARK_ONCE) return 'once';
            if (t === MARK_HOLD) return 'hold';
        }
        for (let i = 0; i < n; i++) {
            if (lines[i].trim() === MARK_SUB) return 'sub';
        }
        return 'on';
    }

    /** 항목 내용을 원하는 상태로 바꾼 새 content 반환. 변화 없으면 null */
    function withEntryState(content, state) {
        // 엔진이 내용을 trim한 뒤 파싱하므로, 앞쪽 빈 줄은 걷어내고 데코레이터 블록을 찾는다
        const lines = String(content ?? '').split('\n');
        while (lines.length > 0 && lines[0].trim() === '') lines.shift();
        const n = decoratorBlockLength(lines);
        const head = lines.slice(0, n).filter((l) => !isMarkLine(l));
        const tail = lines.slice(n);
        if (state === 'hold') head.push(MARK_HOLD);
        if (state === 'once') head.push(MARK_ONCE);
        if (state === 'sub') head.push(MARK_SUB);
        const next = head.concat(tail).join('\n');
        return next === content ? null : next;
    }

    function isToggleable(entry) {
        return entry && entry.mode !== 'folder';
    }

    // ---------------------------------------------------------------
    // 데이터 소스 (캐릭터 / 채팅 / 모듈)
    // ---------------------------------------------------------------

    async function loadSources() {
        const charIndex = await Risuai.getCurrentCharacterIndex();
        const chatIndex = await Risuai.getCurrentChatIndex();
        const char = await Risuai.getCharacter();
        const chat = await Risuai.getChatFromIndex(charIndex, chatIndex);
        const db = await Risuai.getDatabase(['modules', 'enabledModules']);

        const sources = [];

        sources.push({
            id: 'char',
            enabled: true,
            label: `캐릭터 로어북 · ${char?.name ?? ''}`,
            entries: Array.isArray(char?.globalLore) ? char.globalLore : [],
            write: async (entries) => {
                const fresh = await Risuai.getCharacter();
                fresh.globalLore = entries;
                await Risuai.setCharacter(fresh);
            },
        });

        if (chat) {
            sources.push({
                id: 'chat',
                enabled: true,
                label: `채팅 로어북 · ${chat.name ?? '현재 채팅'}`,
                entries: Array.isArray(chat.localLore) ? chat.localLore : [],
                write: async (entries) => {
                    const fresh = await Risuai.getChatFromIndex(charIndex, chatIndex);
                    if (!fresh) return;
                    fresh.localLore = entries;
                    await Risuai.setChatToIndex(charIndex, chatIndex, fresh);
                },
            });
        }

        if (db && Array.isArray(db.modules)) {
            const enabledIds = new Set(
                [].concat(db.enabledModules ?? [], char?.modules ?? [], chat?.modules ?? [])
            );
            db.modules.forEach((mod, modIndex) => {
                if (!mod || !Array.isArray(mod.lorebook) || mod.lorebook.length === 0) return;
                const enabled = enabledIds.has(mod.id);
                sources.push({
                    id: 'module:' + mod.id,
                    enabled,
                    label: `모듈 · ${mod.name}${enabled ? '' : ' (비활성 모듈)'}`,
                    entries: mod.lorebook,
                    write: async (entries) => {
                        const freshDb = await Risuai.getDatabase(['modules']);
                        if (!freshDb || !Array.isArray(freshDb.modules)) return;
                        const target =
                            freshDb.modules.find((m) => m && m.id === mod.id) ?? freshDb.modules[modIndex];
                        if (!target) return;
                        target.lorebook = entries;
                        await Risuai.setDatabaseLite({ modules: freshDb.modules });
                    },
                });
            });
        }

        return sources;
    }

    /**
     * 각 소스를 최신 상태로 다시 읽은 뒤 decide(entry, sourceId, index) 가 돌려주는
     * 상태('on'|'hold'|'once'|undefined)를 적용한다. undefined면 건드리지 않음.
     */
    async function applyStates(decide) {
        const sources = await loadSources();
        let changed = 0;
        for (const source of sources) {
            let dirty = false;
            const entries = source.entries.map((entry, index) => {
                if (!isToggleable(entry)) return entry;
                const want = decide(entry, source.id, index);
                if (want === undefined) return entry;
                const next = withEntryState(entry.content, want);
                if (next === null) return entry;
                dirty = true;
                changed++;
                return { ...entry, content: next };
            });
            if (dirty) {
                await source.write(entries);
            }
        }
        return changed;
    }

    /** 데코레이터 블록을 뺀 본문 (엔진이 프롬프트로 쓰는 부분) */
    function entryBody(entry) {
        const lines = String(entry?.content ?? '').trimStart().split('\n');
        const n = decoratorBlockLength(lines);
        return lines.slice(n).join('\n').replace(/\r\n/g, '\n').trim();
    }

    function escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * 보조모델 요청 메시지에서 항목 본문을 찾아내는 정규식.
     * CBS({{char}} 등)는 치환된 뒤라 정확히 알 수 없으므로, CBS 사이의 리터럴 조각들을
     * 순서대로 잇되 사이에 최대 400자까지 허용한다. 리터럴이 너무 짧으면 오탐 위험이 커서 포기.
     */
    function bodyMatcher(body) {
        const normalized = body.replace(/\s+/g, ' ').trim();
        const literals = normalized
            .split(/\{\{[^{}]*(?:\{\{[^{}]*\}\}[^{}]*)*\}\}/g)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const literalLength = literals.reduce((a, l) => a + l.length, 0);
        if (literalLength < 12) return null;
        const parts = literals.map((l) => escapeRegex(l).replace(/ /g, '\\s+'));
        return new RegExp(parts.join('[\\s\\S]{0,400}?'), 'g');
    }

    /** 보조모델 요청 메시지 배열에서 sub 항목들을 걷어낸다 */
    function stripSubEntries(messages, entries) {
        const matchers = entries.map((e) => bodyMatcher(entryBody(e))).filter(Boolean);
        if (matchers.length === 0) return { messages, removed: 0 };
        let removed = 0;
        const out = [];
        for (const msg of messages) {
            if (typeof msg?.content !== 'string' || msg.content.length === 0) {
                out.push(msg);
                continue;
            }
            let content = msg.content;
            for (const re of matchers) {
                re.lastIndex = 0;
                const next = content.replace(re, () => {
                    removed++;
                    return '';
                });
                content = next;
            }
            if (content === msg.content) {
                out.push(msg);
            } else if (content.trim().length === 0 && !msg.multimodals) {
                // 항목만 담고 있던 메시지는 통째로 제거
            } else {
                out.push({ ...msg, content: content.replace(/\n{3,}/g, '\n\n').trim() });
            }
        }
        return { messages: out, removed };
    }

    // ---------------------------------------------------------------
    // 원샷(이번 턴만) 자동 복구 + 보조모델 제외
    // ---------------------------------------------------------------

    // 로어북은 전송 파이프라인 앞부분에서 한 번 계산되고, 그 뒤에 'process' 훅이
    // 메시지마다 호출된다. 그 시점에 once 마커를 걷어내면 이번 턴에는 빠지고
    // 다음 턴부터 정상 복구된다. 'output' 훅은 빈 메시지 전송 같은 예외 경로용 백업.
    let pendingOnce = false;
    let hasSub = false;
    let restoring = null;

    async function scanFlags() {
        try {
            const sources = await loadSources();
            pendingOnce = false;
            hasSub = false;
            for (const s of sources) {
                for (const e of s.entries) {
                    if (!isToggleable(e)) continue;
                    const st = getEntryState(e);
                    if (st === 'once') pendingOnce = true;
                    if (st === 'sub') hasSub = true;
                }
            }
        } catch (e) {
            console.log(`상태 스캔 실패: ${e?.message ?? e}`);
        }
    }

    async function restoreOnce() {
        if (!pendingOnce) return;
        if (restoring) return restoring;
        restoring = (async () => {
            try {
                await applyStates((entry) => (getEntryState(entry) === 'once' ? 'on' : undefined));
                pendingOnce = false;
            } catch (e) {
                console.log(`once 복구 실패: ${e?.message ?? e}`);
            } finally {
                restoring = null;
            }
        })();
        return restoring;
    }

    const processHandler = async (content) => {
        await restoreOnce();
        return content;
    };
    const outputHandler = async (content) => {
        await restoreOnce();
        return content;
    };

    // 요청 종류: 'model'(메인 채팅) | 'submodel' | 'otherAx'(루아 axLLM 등) | 'memory' | 'emotion' | 'translate'
    // - once 복구: 채팅 전송이 아닌 보조모델 단독 호출(삽화 모듈 등)에서도 로어북이 이미 계산된 뒤라 여기서 풀어준다.
    //   'translate'는 입력 번역처럼 전송 전에 올 수 있어 제외.
    // - sub 제외: 메인 채팅 요청이 아니면 sub 항목을 메시지에서 걷어낸다.
    const beforeRequestHandler = async (messages, type) => {
        try {
            if (type !== 'translate') {
                await restoreOnce();
            }
            if (type !== 'model' && hasSub && Array.isArray(messages)) {
                const sources = await loadSources();
                const subEntries = [];
                for (const s of sources) {
                    for (const e of s.entries) {
                        if (isToggleable(e) && getEntryState(e) === 'sub') subEntries.push(e);
                    }
                }
                const result = stripSubEntries(messages, subEntries);
                if (result.removed > 0) {
                    console.log(`보조모델 요청(${type})에서 로어북 ${result.removed}개 제거`);
                }
                return result.messages;
            }
        } catch (e) {
            console.log(`beforeRequest 처리 실패: ${e?.message ?? e}`);
        }
        return messages;
    };

    await Risuai.addRisuScriptHandler('process', processHandler);
    await Risuai.addRisuScriptHandler('output', outputHandler);
    await Risuai.addRisuReplacer('beforeRequest', beforeRequestHandler);

    // ---------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------

    let offMode = 'hold'; // 'hold' | 'once' | 'sub'  (끄기 버튼이 적용할 상태)
    let filterText = '';
    let expanded = new Set(); // 기본은 모두 접힘. 펼친 그룹만 기록
    let hideDisabledModules = true; // 비활성 모듈 안 보기 (기본 켬)
    const PREF_KEY = 'lbtoggle_prefs';

    async function loadPrefs() {
        try {
            const raw = await Risuai.pluginStorage.getItem(PREF_KEY);
            const prefs = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (prefs && typeof prefs.hideDisabledModules === 'boolean') {
                hideDisabledModules = prefs.hideDisabledModules;
            }
            if (prefs && (prefs.offMode === 'hold' || prefs.offMode === 'once' || prefs.offMode === 'sub')) {
                offMode = prefs.offMode;
            }
        } catch (e) {
            /* 기본값 사용 */
        }
    }

    async function savePrefs() {
        try {
            await Risuai.pluginStorage.setItem(PREF_KEY, JSON.stringify({ hideDisabledModules, offMode }));
        } catch (e) {
            /* 저장 실패는 무시 */
        }
    }

    /** 화면에 보일 소스인지 (비활성 모듈 숨김 옵션 반영) */
    function isVisibleSource(source) {
        return !(hideDisabledModules && source.enabled === false);
    }

    const STYLE = `
        * { box-sizing: border-box; }
        html, body { margin: 0; height: 100%; }
        body {
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
            background: rgba(10, 10, 14, 0.72);
            color: #e8e8ec;
            display: flex; align-items: center; justify-content: center;
            padding: 16px;
        }
        .panel {
            width: min(720px, 100%); max-height: 100%;
            background: #16161c; border: 1px solid #2c2c36; border-radius: 14px;
            display: flex; flex-direction: column; overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,.5);
        }
        header {
            display: flex; align-items: center; gap: 10px;
            padding: 14px 16px; border-bottom: 1px solid #2c2c36;
        }
        header h1 { font-size: 16px; margin: 0; flex: 1; }
        .toolbar {
            display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
            padding: 10px 16px; border-bottom: 1px solid #2c2c36; background: #1b1b22;
        }
        .toolbar input[type=text] {
            flex: 1; min-width: 140px; padding: 7px 10px; border-radius: 8px;
            border: 1px solid #33333f; background: #101015; color: inherit; font-size: 13px;
        }
        button {
            font: inherit; font-size: 13px; cursor: pointer; border-radius: 8px;
            border: 1px solid #33333f; background: #22222b; color: #e8e8ec; padding: 6px 10px;
        }
        button:hover { background: #2b2b36; }
        button.danger { border-color: #6a2b35; background: #3a1b22; }
        button.danger:hover { background: #4a2029; }
        button.good { border-color: #2b5a3f; background: #1b3a2a; }
        button.good:hover { background: #22482f; }
        button.ghost { background: transparent; border-color: transparent; }
        .seg { display: inline-flex; border: 1px solid #33333f; border-radius: 8px; overflow: hidden; }
        .seg button { border: 0; border-radius: 0; }
        .seg button.active { background: #4b4bd8; color: #fff; }
        .quickbar { padding-top: 8px; padding-bottom: 8px; gap: 12px; }
        .opt { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: #b0b0bd; cursor: pointer; user-select: none; margin-left: auto; }
        .opt input { accent-color: #4b4bd8; }
        .quick { display: inline-flex; align-items: center; gap: 6px; }
        .quick-label { font-size: 12.5px; color: #b0b0bd; }
        .quick button { padding: 4px 9px; font-size: 12.5px; }
        .list { overflow: auto; flex: 1; }
        .group { border-bottom: 1px solid #22222a; }
        .group-head {
            position: sticky; top: 0; z-index: 1;
            display: flex; align-items: center; gap: 8px;
            padding: 8px 16px; background: #1b1b22; font-size: 13px; font-weight: 600;
        }
        .group-head .name { flex: 1; cursor: pointer; user-select: none; }
        .group-head .count { color: #8a8a99; font-weight: 400; }
        .row {
            display: flex; align-items: center; gap: 10px;
            padding: 8px 16px; border-top: 1px solid #1f1f27;
        }
        .row:hover { background: #1b1b22; }
        .row .info { flex: 1; min-width: 0; }
        .row .title { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .row .meta { font-size: 11.5px; color: #8a8a99; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
        .row.off .title { color: #8a8a99; text-decoration: line-through; }
        .badge {
            font-size: 11px; padding: 2px 7px; border-radius: 999px; font-weight: 600; min-width: 44px; text-align: center;
        }
        .badge.on { background: #1f4d33; color: #8fe2b0; }
        .badge.hold { background: #4d1f2a; color: #f08ea3; }
        .badge.once { background: #4d3b1f; color: #f0c98e; }
        .badge.sub { background: #1f2f4d; color: #8ec0f0; }
        .row.sub .title { color: #c9d6e6; text-decoration: none; }
        .row .toggle { min-width: 64px; }
        .empty { padding: 32px 16px; text-align: center; color: #8a8a99; font-size: 13px; }
        footer {
            padding: 10px 16px; border-top: 1px solid #2c2c36; font-size: 12px; color: #8a8a99;
            display: flex; gap: 8px; align-items: center;
        }
        footer .status { flex: 1; }
    `;

    function esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function entryTitle(entry) {
        if (entry.comment && entry.comment.trim()) return entry.comment;
        if (entry.key && entry.key.trim()) return entry.key;
        const body = String(entry.content ?? '').split('\n').find((l) => l.trim() && !l.trimStart().startsWith('@@'));
        return (body ?? '(이름 없음)').slice(0, 40);
    }

    function entryMeta(entry, folderNames) {
        const parts = [];
        if (entry.folder && folderNames.has(entry.folder)) parts.push('📁 ' + folderNames.get(entry.folder));
        if (entry.alwaysActive) parts.push('상시');
        else if (entry.key) parts.push('키: ' + entry.key);
        if (entry.selective && entry.secondkey) parts.push('보조: ' + entry.secondkey);
        return parts.join(' · ');
    }

    function badgeLabel(state) {
        return state === 'on' ? 'ON' : state === 'hold' ? 'OFF' : state === 'once' ? '1턴 OFF' : '보조 OFF';
    }

    let statusText = '';
    function setStatus(text) {
        statusText = text;
        const el = document.getElementById('lbt-status');
        if (el) el.textContent = text;
    }

    async function act(label, fn) {
        setStatus(label + '…');
        try {
            const n = await fn();
            await scanFlags();
            setStatus(typeof n === 'number' ? `${label} 완료 (${n}개 변경)` : `${label} 완료`);
        } catch (e) {
            setStatus(`${label} 실패: ${e?.message ?? e}`);
        }
        await render();
    }

    function matchesFilter(entry) {
        if (!filterText) return true;
        const q = filterText.toLowerCase();
        return (
            String(entry.comment ?? '').toLowerCase().includes(q) ||
            String(entry.key ?? '').toLowerCase().includes(q) ||
            String(entry.secondkey ?? '').toLowerCase().includes(q)
        );
    }

    const CATEGORIES = [
        { id: 'char', label: '캐릭터', test: (sid) => sid === 'char' },
        { id: 'chat', label: '채팅', test: (sid) => sid === 'chat' },
        { id: 'module', label: '모듈 전체', test: (sid) => sid.startsWith('module:') },
    ];

    async function render() {
        const prevList = document.querySelector('.list');
        const prevScroll = prevList ? prevList.scrollTop : 0;
        let sources;
        try {
            sources = await loadSources();
        } catch (e) {
            document.body.innerHTML = `<style>${STYLE}</style>
                <div class="panel"><header><h1>로어북 토글</h1>
                <button class="ghost" id="lbt-close">✕</button></header>
                <div class="empty">로어북을 불러오지 못했어요.<br>${esc(e?.message ?? e)}<br><br>
                플러그인에 데이터베이스/캐릭터 접근 권한을 허용했는지 확인해주세요.</div></div>`;
            document.getElementById('lbt-close').onclick = () => Risuai.hideContainer();
            return;
        }

        const hiddenCount = sources.filter((src) => !isVisibleSource(src)).length;
        sources = sources.filter(isVisibleSource);
        const visibleSourceIds = new Set(sources.map((src) => src.id));

        const total = { all: 0, off: 0 };
        const groupsHtml = sources
            .map((source) => {
                const folderNames = new Map();
                source.entries.forEach((e) => {
                    if (e && e.mode === 'folder') folderNames.set(e.key, e.comment || '폴더');
                });
                const items = source.entries
                    .map((entry, index) => ({ entry, index }))
                    .filter(({ entry }) => isToggleable(entry) && matchesFilter(entry));
                if (items.length === 0) return '';

                const offCount = items.filter(({ entry }) => getEntryState(entry) !== 'on').length;
                total.all += items.length;
                total.off += offCount;
                const isCollapsed = !expanded.has(source.id);

                const rows = isCollapsed
                    ? ''
                    : items
                          .map(({ entry, index }) => {
                              const state = getEntryState(entry);
                              return `
                    <div class="row ${state === 'on' ? '' : state === 'sub' ? 'sub' : 'off'}" data-source="${esc(source.id)}" data-index="${index}">
                        <span class="badge ${state}">${badgeLabel(state)}</span>
                        <div class="info">
                            <div class="title">${esc(entryTitle(entry))}</div>
                            <div class="meta">${esc(entryMeta(entry, folderNames))}</div>
                        </div>
                        <button class="toggle ${state === 'on' ? 'danger' : 'good'}" data-act="toggle">
                            ${state === 'on' ? '끄기' : '켜기'}
                        </button>
                    </div>`;
                          })
                          .join('');

                return `
                <div class="group" data-source="${esc(source.id)}">
                    <div class="group-head">
                        <span class="name" data-act="collapse">${isCollapsed ? '▸' : '▾'} ${esc(source.label)}
                            <span class="count">(${items.length}개, OFF ${offCount})</span></span>
                        <button class="danger" data-act="group-off">전체 끄기</button>
                        <button class="good" data-act="group-on">전체 켜기</button>
                    </div>
                    ${rows}
                </div>`;
            })
            .join('');

        const presentCategories = CATEGORIES.filter((cat) =>
            sources.some((src) => cat.test(src.id) && src.entries.some(isToggleable))
        );
        const quickHtml = presentCategories
            .map(
                (cat) => `
                <span class="quick">
                    <span class="quick-label">${esc(cat.label)}</span>
                    <button class="danger" data-cat-off="${cat.id}">끄기</button>
                    <button class="good" data-cat-on="${cat.id}">켜기</button>
                </span>`
            )
            .join('') +
            `<label class="opt" title="꺼져 있는 모듈의 로어북은 어차피 프롬프트에 안 들어가요">
                <input type="checkbox" id="lbt-hide-disabled" ${hideDisabledModules ? 'checked' : ''}>
                비활성 모듈 안 보기${hiddenCount > 0 && hideDisabledModules ? ` (${hiddenCount}개 숨김)` : ''}
            </label>`;

        document.body.innerHTML = `<style>${STYLE}</style>
        <div class="panel">
            <header>
                <h1>📕 로어북 토글 <span style="font-weight:400;color:#8a8a99;font-size:13px">총 ${total.all}개 · OFF ${total.off}</span></h1>
                <button class="ghost" id="lbt-close" title="닫기">✕</button>
            </header>
            <div class="toolbar">
                <span class="seg" title="끄기 버튼을 눌렀을 때 적용되는 방식">
                    <button data-mode="hold" class="${offMode === 'hold' ? 'active' : ''}">고정 끄기</button>
                    <button data-mode="once" class="${offMode === 'once' ? 'active' : ''}">이번 턴만 끄기</button>
                    <button data-mode="sub" class="${offMode === 'sub' ? 'active' : ''}">보조모델만 끄기</button>
                </span>
                <input type="text" id="lbt-filter" placeholder="이름 / 키 검색" value="${esc(filterText)}">
                <button class="danger" data-act="all-off">모두 끄기</button>
                <button class="good" data-act="all-on">모두 켜기</button>
            </div>
            <div class="toolbar quickbar">${quickHtml}</div>
            <div class="list">
                ${groupsHtml || '<div class="empty">표시할 로어북 항목이 없어요.</div>'}
            </div>
            <footer>
                <span class="status" id="lbt-status">${esc(statusText)}</span>
                <span>${
                    offMode === 'once'
                        ? '이번 턴만: 다음 메인/보조모델 요청이 나간 뒤 자동으로 다시 켜져요'
                        : offMode === 'sub'
                          ? '보조모델만: 메인 채팅엔 들어가고 보조모델(삽화·요약 등) 요청에서만 빠져요'
                          : '고정: 다시 켤 때까지 꺼져 있어요'
                }</span>
            </footer>
        </div>`;

        document.getElementById('lbt-close').onclick = () => Risuai.hideContainer();

        const listEl = document.querySelector('.list');
        if (listEl) listEl.scrollTop = prevScroll;

        document.querySelectorAll('[data-mode]').forEach((btn) => {
            btn.onclick = () => {
                offMode = btn.getAttribute('data-mode');
                savePrefs();
                render();
            };
        });

        const hideEl = document.getElementById('lbt-hide-disabled');
        if (hideEl) {
            hideEl.onchange = () => {
                hideDisabledModules = hideEl.checked;
                savePrefs();
                render();
            };
        }

        const filterEl = document.getElementById('lbt-filter');
        let filterTimer = null;
        filterEl.oninput = () => {
            filterText = filterEl.value.trim();
            clearTimeout(filterTimer);
            filterTimer = setTimeout(async () => {
                const pos = filterEl.selectionStart;
                await render();
                const again = document.getElementById('lbt-filter');
                if (again) {
                    again.focus();
                    again.setSelectionRange(pos, pos);
                }
            }, 150);
        };

        const visible = (sid) => visibleSourceIds.has(sid);
        document.querySelector('[data-act="all-off"]').onclick = () =>
            act('모두 끄기', () =>
                applyStates((entry, sid) =>
                    visible(sid) && matchesFilter(entry) && getEntryState(entry) === 'on' ? offMode : undefined
                )
            );
        document.querySelector('[data-act="all-on"]').onclick = () =>
            act('모두 켜기', () =>
                applyStates((entry, sid) =>
                    visible(sid) && matchesFilter(entry) && getEntryState(entry) !== 'on' ? 'on' : undefined
                )
            );

        presentCategories.forEach((cat) => {
            document.querySelector(`[data-cat-off="${cat.id}"]`).onclick = () =>
                act(`${cat.label} 끄기`, () =>
                    applyStates((entry, sid) =>
                        visible(sid) && cat.test(sid) && matchesFilter(entry) && getEntryState(entry) === 'on'
                            ? offMode
                            : undefined
                    )
                );
            document.querySelector(`[data-cat-on="${cat.id}"]`).onclick = () =>
                act(`${cat.label} 켜기`, () =>
                    applyStates((entry, sid) =>
                        visible(sid) && cat.test(sid) && matchesFilter(entry) && getEntryState(entry) !== 'on'
                            ? 'on'
                            : undefined
                    )
                );
        });

        document.querySelectorAll('.group').forEach((groupEl) => {
            const sourceId = groupEl.getAttribute('data-source');
            groupEl.querySelector('[data-act="collapse"]').onclick = () => {
                if (expanded.has(sourceId)) expanded.delete(sourceId);
                else expanded.add(sourceId);
                render();
            };
            groupEl.querySelector('[data-act="group-off"]').onclick = () =>
                act('그룹 끄기', () =>
                    applyStates((entry, sid) =>
                        sid === sourceId && matchesFilter(entry) && getEntryState(entry) === 'on' ? offMode : undefined
                    )
                );
            groupEl.querySelector('[data-act="group-on"]').onclick = () =>
                act('그룹 켜기', () =>
                    applyStates((entry, sid) =>
                        sid === sourceId && matchesFilter(entry) && getEntryState(entry) !== 'on' ? 'on' : undefined
                    )
                );
        });

        document.querySelectorAll('.row').forEach((rowEl) => {
            const sourceId = rowEl.getAttribute('data-source');
            const index = Number(rowEl.getAttribute('data-index'));
            rowEl.querySelector('[data-act="toggle"]').onclick = () =>
                act('변경', () =>
                    applyStates((entry, sid, i) => {
                        if (sid !== sourceId || i !== index) return undefined;
                        return getEntryState(entry) === 'on' ? offMode : 'on';
                    })
                );
        });
    }

    async function open() {
        statusText = '';
        await render();
        await Risuai.showContainer('fullscreen');
    }

    const button = await Risuai.registerButton(
        {
            name: '로어북 토글',
            icon: '<span data-lbtoggle-btn="1">📕</span>',
            iconType: 'html',
            location: 'action',
            id: BUTTON_ID,
        },
        open
    );

    // ---------------------------------------------------------------
    // 진입 버튼 스타일: 리수 기본 파란색(bg-blue-500) → 반투명 회색
    // 메인 화면 접근 권한이 필요해서 시작 1.5초 뒤 한 번 묻고, 채팅 화면이 다시 그려질 때마다 재적용
    // ---------------------------------------------------------------
    const ENTRY_BTN_STYLE =
        'background:rgba(127,127,127,.16);color:var(--risu-theme-textcolor,#d1d5db);' +
        'border:1px solid rgba(127,127,127,.38);box-shadow:none;' +
        'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:.8';
    let rootDoc = null;
    let styleTimer = null;

    async function styleEntryButton() {
        if (!rootDoc) return;
        try {
            const all = await Risuai.unwarpSafeArray(
                await rootDoc.querySelectorAll('div.fixed.top-4.right-4 > button')
            );
            for (const el of all) {
                const html = String(await el.getInnerHTML());
                if (!html.includes('data-lbtoggle-btn')) continue;
                if ((await el.getAttribute('x-lbtoggle-styled')) === '1') continue;
                for (const c of ['bg-blue-500', 'hover:bg-blue-600', 'text-white', 'shadow-lg']) {
                    await el.removeClass(c);
                }
                await el.setStyleAttribute(ENTRY_BTN_STYLE);
                await el.setAttribute('x-lbtoggle-styled', '1');
            }
        } catch (e) {
            /* 화면이 바뀌는 중이면 조용히 다음 틱에 재시도 */
        }
    }

    (async () => {
        try {
            if (await Risuai.getArgument('keep_blue')) return;
            await new Promise((r) => setTimeout(r, 1500));
            rootDoc = await Risuai.getRootDocument();
            if (!rootDoc) return;
            await styleEntryButton();
            styleTimer = setInterval(styleEntryButton, 2500);
        } catch (e) {
            console.log(`진입 버튼 스타일 적용 실패: ${e?.message ?? e}`);
        }
    })();

    await Risuai.onUnload(async () => {
        if (styleTimer) clearInterval(styleTimer);
        try {
            await Risuai.removeRisuScriptHandler('process', processHandler);
            await Risuai.removeRisuScriptHandler('output', outputHandler);
            await Risuai.removeRisuReplacer('beforeRequest', beforeRequestHandler);
            if (button && button.id) await Risuai.unregisterUIPart(button.id);
        } catch (e) {
            /* ignore */
        }
    });

    await loadPrefs();
    await scanFlags();
    console.log('Lorebook Toggle 로드 완료');
})();
