//@name lorebook_toggle
//@display-name Lorebook Toggle
//@api 3.0
//@version 1.4.2
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
 *     `@@dont_activate lbtoggle once`   (이번 턴만: 다음 채팅 전송 때 자동 복구)
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
        // 너무 긴 항목은 정규식이 거대해져 엔진이 거부할 수 있으니 줄 단위 매칭으로 넘긴다
        if (literalLength > 1500 || literals.length > 60) return null;
        const parts = literals.map((l) => escapeRegex(l).replace(/ /g, '\\s+'));
        try {
            return new RegExp(parts.join('[\\s\\S]{0,400}?'), 'g');
        } catch (e) {
            return null;
        }
    }

    function normalizeLine(line) {
        return line.replace(/\s+/g, ' ').trim();
    }

    /** CBS가 없는 리터럴 줄들 (줄 단위 보조 매칭용) */
    function literalLines(body) {
        return body
            .split('\n')
            .map(normalizeLine)
            .filter((l) => l.length >= 10 && !l.includes('{{'));
    }

    /**
     * 보조모델 요청 메시지 배열에서 sub 항목들을 걷어낸다.
     * 1차: 항목 전체를 정규식으로 찾아 통째로 제거 (full)
     * 2차: 1차가 실패한 항목은 CBS 없는 줄들을 줄 단위로 제거 (partial) — {{#if}} 분기처럼
     *      치환 결과를 예측할 수 없는 항목도 최소한 리터럴 부분은 빠지게 한다.
     * 반환: { messages, removed, results: [{ entry, result: 'full'|'partial'|'none' }] }
     */
    function stripSubEntries(messages, entries) {
        const plans = entries.map((entry) => {
            const body = entryBody(entry);
            return { entry, re: bodyMatcher(body), lines: literalLines(body), result: 'none' };
        });
        let removed = 0;
        let out = messages.map((m) => m);

        // 1차: 정규식 통째 제거
        for (const plan of plans) {
            if (!plan.re) continue;
            out = out.map((msg) => {
                if (typeof msg?.content !== 'string' || msg.content.length === 0) return msg;
                plan.re.lastIndex = 0;
                let hit = false;
                const content = msg.content.replace(plan.re, () => {
                    hit = true;
                    return '';
                });
                if (!hit) return msg;
                plan.result = 'full';
                removed++;
                return { ...msg, content };
            });
        }

        // 2차: 줄 단위 제거 (태그로 감싸져 같은 줄에 붙어 있어도 잡히도록 부분 문자열로 지운다)
        for (const plan of plans) {
            if (plan.result === 'full' || plan.lines.length === 0) continue;
            const lineRes = plan.lines.map(
                (l) => new RegExp(escapeRegex(l).replace(/ /g, '\\s+'), 'g')
            );
            out = out.map((msg) => {
                if (typeof msg?.content !== 'string' || msg.content.length === 0) return msg;
                let hits = 0;
                let content = msg.content;
                for (const re of lineRes) {
                    re.lastIndex = 0;
                    content = content.replace(re, () => {
                        hits++;
                        return '';
                    });
                }
                if (hits === 0) return msg;
                plan.result = 'partial';
                removed++;
                return { ...msg, content };
            });
        }

        // 비워진 메시지는 통째로 제거, 빈 줄 정리
        out = out.filter((msg) => {
            if (typeof msg?.content !== 'string') return true;
            const original = messages.find((m) => m === msg);
            if (original) return true; // 손대지 않은 메시지
            return msg.content.trim().length > 0 || !!msg.multimodals;
        }).map((msg) => {
            const original = messages.find((m) => m === msg);
            if (original || typeof msg?.content !== 'string') return msg;
            return { ...msg, content: msg.content.replace(/\n{3,}/g, '\n\n').trim() };
        });

        return {
            messages: out,
            removed,
            results: plans.map((p) => ({ entry: p.entry, result: p.result })),
        };
    }

    // ---------------------------------------------------------------
    // 원샷(이번 턴만) 자동 복구 + 보조모델 제외
    // ---------------------------------------------------------------

    // 로어북은 전송 파이프라인 앞부분에서 한 번 계산되고, 그 뒤에 'process' 훅이
    // 메시지마다 호출된다. 그 시점에 once 마커를 걷어내면 이번 턴에는 빠지고
    // 다음 턴부터 정상 복구된다. 응답 뒤에는 타이머로 재확인한다(아래 scheduleRechecks 참고).
    let hasSub = false;
    let restoring = null;

    /** 가벼운 스캔: 로어북 배열만 스냅샷해서 once/sub 마커 유무를 본다 (전체 DB 스냅샷 아님) */
    async function scanMarkers() {
        const result = { once: false, sub: false };
        try {
            const entries = await Risuai.getCurrentLorebookEntries();
            for (const e of entries ?? []) {
                if (!isToggleable(e)) continue;
                const st = getEntryState(e);
                if (st === 'once') result.once = true;
                if (st === 'sub') result.sub = true;
            }
        } catch (e) {
            console.log(`마커 스캔 실패: ${e?.message ?? e}`);
        }
        hasSub = result.sub;
        return result;
    }

    async function scanFlags() {
        await scanMarkers();
    }

    /**
     * once 항목을 켠다. 매번 실제 마커를 다시 확인하므로(플래그에 의존하지 않음),
     * 다른 트리거가 옛 캐릭터 객체를 되써서 마커가 되살아난 경우에도 다음 기회에 다시 복구된다.
     */
    async function restoreOnce(reason) {
        if (restoring) return restoring;
        restoring = (async () => {
            try {
                const { once } = await scanMarkers();
                if (!once) return false;
                const n = await applyStates((entry) => (getEntryState(entry) === 'once' ? 'on' : undefined));
                pushLog({ time: Date.now(), type: 'restore', reason, restored: n });
                return n > 0;
            } catch (e) {
                console.log(`once 복구 실패: ${e?.message ?? e}`);
                return false;
            } finally {
                restoring = null;
            }
        })();
        return restoring;
    }

    // 턴이 끝난 뒤의 재확인.
    // 메인 파이프라인 안('process')에서 복구해도, 그 뒤에 도는 출력 트리거가 파이프라인 시작 때 복제해 둔
    // 옛 캐릭터 객체를 DB에 되쓰면 마커가 되살아난다(v2 로어북 효과 등). 그래서 응답이 끝난 뒤
    // 몇 초 간격으로 다시 확인해서 남아 있으면 복구한다. 보조모델 요청(삽화 등)이 방금 있었으면
    // 버튼 스크립트가 아직 도는 중일 수 있으니 그 동안은 건드리지 않고 미룬다.
    // 메인 채팅 파이프라인 안인지 표시. 'process' 훅은 메인 전송 직전에만 울리고(첫 메시지에도),
    // 'output' 훅은 응답을 받은 뒤 울린다. 그 사이의 type==='model' 요청만 진짜 메인 채팅이고,
    // 그 밖의 'model' 요청은 루아 LLM() 같은 스크립트 호출이므로 보조로 취급한다.
    // 실패/중단으로 'output'이 안 울리면 15분 뒤 자동 해제 (해제 쪽이 "걷어내지 않음"이라 안전).
    let mainChatArmed = false;
    let mainChatArmedAt = 0;
    const MAIN_ARM_TTL = 15 * 60 * 1000;

    let lastAuxAt = 0;
    const AUX_QUIET_MS = 45 * 1000;
    const RECHECK_DELAYS = [3000, 8000, 20000, 45000, 90000];
    let recheckTimers = [];

    function scheduleRechecks() {
        for (const t of recheckTimers) clearTimeout(t);
        recheckTimers = RECHECK_DELAYS.map((d) =>
            setTimeout(async () => {
                if (mainChatArmed) return;
                if (Date.now() - lastAuxAt < AUX_QUIET_MS) {
                    // 보조 호출 직후: 다음 타이머에서 다시 본다
                    return;
                }
                await restoreOnce('턴 종료 후 재확인');
            }, d)
        );
    }

    let processRestoredThisTurn = false;

    //   'output'  — 응답 수신 뒤 (백업)
    const inputHandler = async (content) => {
        await restoreOnce('입력 전송 직후');
        return content;
    };
    const processHandler = async (content) => {
        const wasArmed = mainChatArmed;
        mainChatArmed = true;
        mainChatArmedAt = Date.now();
        if (!wasArmed) processRestoredThisTurn = false;
        if (!processRestoredThisTurn) {
            processRestoredThisTurn = true;
            await restoreOnce('전송 파이프라인 안');
        }
        return content;
    };
    const outputHandler = async (content) => {
        mainChatArmed = false;
        processRestoredThisTurn = false;
        scheduleRechecks();
        return content;
    };

    // 최근 요청 기록 (패널에서 확인용)
    const requestLog = [];
    const REQUEST_LOG_MAX = 20;
    function pushLog(item) {
        requestLog.unshift(item);
        if (requestLog.length > REQUEST_LOG_MAX) requestLog.length = REQUEST_LOG_MAX;
    }

    // 요청 종류: 'model'(메인 채팅) | 'submodel' | 'otherAx'(루아 axLLM 등) | 'memory' | 'emotion' | 'translate'
    // 여기서는 DB에 아무것도 쓰지 않는다. sub 제외는 메시지 배열만 바꾸는 순수 처리.
    const beforeRequestHandler = async (messages, type) => {
        const log = {
            time: Date.now(),
            type,
            isMain: false,
            msgCount: Array.isArray(messages) ? messages.length : 0,
            removed: 0,
            results: [],
            error: null,
        };
        try {
            const armed = mainChatArmed && Date.now() - mainChatArmedAt < MAIN_ARM_TTL;
            log.isMain = type === 'model' && armed;
            if (!log.isMain) lastAuxAt = Date.now();
            if (!log.isMain && hasSub && Array.isArray(messages)) {
                const sources = await loadSources();
                const subEntries = [];
                for (const s of sources) {
                    for (const e of s.entries) {
                        if (isToggleable(e) && getEntryState(e) === 'sub') subEntries.push(e);
                    }
                }
                const result = stripSubEntries(messages, subEntries);
                log.removed = result.removed;
                log.results = result.results.map((r) => ({ name: entryTitle(r.entry), result: r.result }));
                if (result.removed > 0) {
                    console.log(`보조모델 요청(${type})에서 로어북 ${result.removed}개 제거`);
                }
                pushLog(log);
                return result.messages;
            }
        } catch (e) {
            log.error = String(e?.message ?? e);
            console.log(`beforeRequest 처리 실패: ${log.error}`);
        }
        pushLog(log);
        return messages;
    };

    await Risuai.addRisuScriptHandler('input', inputHandler);
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
    let logOpen = false;
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
        .log { border-top: 1px solid #2c2c36; background: #131318; max-height: 38%; display: flex; flex-direction: column; }
        .log-head { display: flex; align-items: center; gap: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; user-select: none; }
        .log-head .hint { font-weight: 400; color: #8a8a99; font-size: 12px; flex: 1; }
        .log-body { overflow: auto; padding: 0 16px 10px; font-size: 12px; }
        .log-item { padding: 6px 0; border-top: 1px solid #1f1f27; color: #c8c8d2; }
        .log-item .l1 { display: flex; gap: 8px; flex-wrap: wrap; }
        .log-item .tag { padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 600; }
        .tag.main { background: #1f4d33; color: #8fe2b0; }
        .tag.aux { background: #1f2f4d; color: #8ec0f0; }
        .tag.skip { background: #2a2a33; color: #9a9aa8; }
        .log-item .l2 { color: #8a8a99; margin-top: 2px; }
        .log-item .ok { color: #8fe2b0; }
        .log-item .part { color: #f0c98e; }
        .log-item .miss { color: #f08ea3; }
        .log-empty { color: #8a8a99; padding: 6px 0 2px; line-height: 1.5; }
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

    function typeLabel(item) {
        if (item.type === 'restore') return `이번 턴만 복구 (${item.reason})`;
        const names = {
            model: '메인 모델',
            submodel: '보조 모델',
            otherAx: '보조 (루아 axLLM 등)',
            memory: '메모리 요약',
            emotion: '감정',
            translate: '번역',
        };
        return names[item.type] ?? item.type;
    }

    function renderLog() {
        if (requestLog.length === 0) {
            return `<div class="log-empty">아직 요청이 지나가지 않았어요.<br>
                채팅을 보냈거나 삽화를 뽑았는데도 계속 비어 있으면, 플러그인 시작 때 뜨는
                <b>요청 수정(replacer) 권한</b>을 거부한 상태일 수 있어요. 리수를 새로고침한 뒤 허용해주세요.</div>`;
        }
        return requestLog
            .map((item) => {
                const t = new Date(item.time);
                const hh = String(t.getHours()).padStart(2, '0');
                const mm = String(t.getMinutes()).padStart(2, '0');
                const ss = String(t.getSeconds()).padStart(2, '0');
                if (item.type === 'restore') {
                    return `<div class="log-item"><div class="l1"><span>${hh}:${mm}:${ss}</span><span class="tag main">이번 턴만 → 켜짐</span><span>${esc(item.reason)}</span><span>${item.restored}개</span></div></div>`;
                }
                const tag = item.isMain
                    ? '<span class="tag main">메인 채팅 · 손대지 않음</span>'
                    : item.results.length === 0
                      ? '<span class="tag skip">보조 · 걷어낼 항목 없음</span>'
                      : '<span class="tag aux">보조 · 제외 적용</span>';
                const detail = item.results
                    .map((r) => {
                        const cls = r.result === 'full' ? 'ok' : r.result === 'partial' ? 'part' : 'miss';
                        const mark = r.result === 'full' ? '✓' : r.result === 'partial' ? '△' : '✕';
                        return `<span class="${cls}">${mark} ${esc(r.name)}</span>`;
                    })
                    .join(' · ');
                return `<div class="log-item">
                    <div class="l1"><span>${hh}:${mm}:${ss}</span><span>${esc(typeLabel(item))}</span>${tag}<span>메시지 ${item.msgCount}개</span>${
                        item.removed > 0 ? `<span>제거 ${item.removed}</span>` : ''
                    }${item.error ? `<span class="miss">오류: ${esc(item.error)}</span>` : ''}</div>
                    ${detail ? `<div class="l2">${detail}</div>` : ''}
                </div>`;
            })
            .join('');
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
            <div class="log">
                <div class="log-head" id="lbt-log-toggle">${logOpen ? '▾' : '▸'} 최근 요청 기록
                    <span class="hint">${
                        requestLog.length === 0
                            ? '아직 기록 없음'
                            : `${requestLog.length}건 · 마지막: ${typeLabel(requestLog[0])}${requestLog[0].removed > 0 ? ` · 제거 ${requestLog[0].removed}` : ''}`
                    }</span>
                </div>
                ${logOpen ? `<div class="log-body">${renderLog()}</div>` : ''}
            </div>
            <footer>
                <span class="status" id="lbt-status">${esc(statusText)}</span>
                <span>${
                    offMode === 'once'
                        ? '이번 턴만: 다음 채팅 전송 때 자동으로 다시 켜져요 (삽화 같은 보조 호출만 하면 그때까진 꺼진 채 유지)'
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

        const logToggle = document.getElementById('lbt-log-toggle');
        if (logToggle) {
            logToggle.onclick = () => {
                logOpen = !logOpen;
                render();
            };
        }

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
        for (const t of recheckTimers) clearTimeout(t);
        try {
            await Risuai.removeRisuScriptHandler('input', inputHandler);
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
