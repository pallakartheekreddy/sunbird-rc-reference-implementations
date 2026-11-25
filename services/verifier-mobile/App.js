// Flow 3: the installed mobile verifier, for both use cases.
//
// Deliberately thin. The charter is explicit that the mobile UI "displays
// results; it does not independently trust claims or make cryptographic
// decisions", and that one reusable verification service serves both the web and
// mobile channels. So this screen does exactly three things:
//
//   1. POST <api>/sessions               — ask the verifier service for a request
//   2. Linking.openURL(openid4vp://...)  — hand that request to the wallet
//   3. GET  <api>/sessions/{id}          — poll, and render whatever it says
//
// There is no credential parsing here, no signature check, no age comparison, no
// loan arithmetic. Every one of those happens server side, and the public gateway
// enforces it: /vp/* is refused on the citizen listener, so this app could not
// reach the protocol endpoints directly even if it tried.
//
// Iteration 02 added the second use case, and the ONLY thing that differs between
// them is `<api>` and the labels — see USE_CASES below. That is the charter's
// "one reusable verification service serves both channels" made visible: the farm
// credit screen contains no lending logic, and the age screen no age logic,
// because neither app ever had any.
//
// A note for whoever adds a third: the loan figure this screen prints is
// `loan.maximumLoanFormatted`, already formatted by the service in Indian digit
// grouping. Do not recompute it here from the rate and the acreage. A mobile app
// capable of producing a different number from the same credential is a second
// implementation of the lending policy, which is exactly what the iteration must
// not ship.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';

const BASE = (Constants.expoConfig?.extra?.verifierBaseUrl ?? '').replace(/\/+$/, '');
const POLL_MS = 1500;

/**
 * The two channels this app can be, and everything that differs between them.
 *
 * `api` is the whole functional difference. Both paths are served by the one
 * verifier service; the agriculture namespace exists so a front end can poll and
 * cancel where it started, which it could not always do — the routes under
 * /agriculture were read-only-by-accident and a poll fell through to a 404 that
 * this app would have rendered as "the request expired".
 */
/**
 * The channel this build serves, from app.config.js.
 *
 * Defaults to age so that an Iteration 01 build with no variable set is exactly
 * what it always was. An unknown value is a hard failure rather than a silent
 * fallback: a verifier quietly asking for the wrong credential type is worse
 * than one that will not start.
 */
const USE_CASE_NAME = Constants.expoConfig?.extra?.useCase ?? 'age';
// Baked in by VERIFIER_AGE_THRESHOLD (see app.config.js). The service validates it.
const AGE_THRESHOLD = Constants.expoConfig?.extra?.ageThreshold ?? 18;

/**
 * What NEITHER Education portal ever asks for.
 *
 * This duplicates `NEVER_REQUESTED` in the verifier's Education domain module,
 * which the two WEB portals fetch from /policy rather than hardcode. The
 * duplication is deliberate and narrow: this app is supporting evidence, not the
 * charter's channel (DEMO.md puts the verifier on a website), and a third network
 * call at start-up buys less than it costs here. It is asserted against the served
 * list by tests/unit/mobile-verifier.test.mjs so it cannot drift into claiming a
 * privacy guarantee the request does not make.
 */
const EDUCATION_WITHHELD = [
  'National ID',
  'name',
  'School Student ID',
  'College Student ID',
  'University Student ID',
  'date of birth',
  'address',
  'contact details',
  'subjects and individual marks',
  'transcripts',
  'college qualification and specialization',
  'completion and graduation years',
];

const USE_CASES = {
  age: {
    api: `${BASE}/api/verifier`,
    sessionQuery: `?threshold=${AGE_THRESHOLD}`,
    eyebrow: 'AGE-RESTRICTED SERVICE',
    title: `Prove you are over ${AGE_THRESHOLD}`,
    lede: `This app asks your wallet for one thing only — whether you are over ${AGE_THRESHOLD}. Not your date of birth, not your name.`,
    startLabel: 'Start age check',
    cancelLabel: 'Cancel this check',
    againLabel: 'Run another check',
    nothingLine: 'Nothing was disclosed and no approval was produced.',
    cancelledLine: 'The check was cancelled. Nothing was disclosed and no approval was produced.',
    expiredLine: 'No presentation arrived before the request expired.',
    approved: 'APPROVED',
    rejectedLabel: 'NOT VERIFIED',
    withheld: [],
  },
  agriculture: {
    api: `${BASE}/api/verifier/agriculture`,
    eyebrow: 'GRAMIN BANK — FARM CREDIT',
    title: 'Apply for crop credit',
    lede:
      'This app asks your wallet for six things from two cards — enough to confirm you are a registered farmer, that the land is yours, and how much of it you are cultivating. Not your National ID, not your name, not the size of your holding.',
    startLabel: 'Start farm credit check',
    cancelLabel: 'Cancel this application',
    againLabel: 'Run another application',
    nothingLine: 'Nothing was disclosed and no credit decision was produced.',
    cancelledLine:
      'The application was cancelled. Nothing was disclosed and no credit decision was produced.',
    expiredLine:
      'No presentation arrived before the request expired. Nothing was disclosed and no credit decision was produced.',
    approved: 'ELIGIBLE',
    rejectedLabel: 'REJECTED / UNABLE TO VERIFY',
    // Named so the screen can state what it did NOT receive. A bank that can
    // lend against verified cultivation without learning who the farmer is or
    // how much land they hold is the argument of the iteration, and it is only
    // legible if the app names the absence.
    withheld: ['National ID', 'name', 'land ID', 'total land area', 'district', 'farmer category'],
  },
  // Iteration 03. Two channels, because there are two relying parties — see
  // app.config.js. They share everything except the policy behind them, exactly
  // as the two web portals share one script.
  //
  // `nested: true` marks the response shape: Education returns `disclosed`
  // keyed by credential (school / college / university) rather than flat,
  // because `learnerId` arriving three times IS the correlation the verifier
  // checked, and flattening it would hide the one fact the screen most needs to
  // show. `rule: true` marks that the response carries thresholds to display.
  //
  // `headline: true` means the ELIGIBLE wording comes from the SERVICE. PRODUCT
  // forbids ever saying ADMITTED or implying a job offer, so the words live in
  // the module the tests assert against, never in this file.
  'education-masters': {
    api: `${BASE}/api/verifier/education/masters`,
    eyebrow: "STATE UNIVERSITY — MASTER'S ADMISSIONS",
    title: "Apply for a Computer Science Master's",
    lede:
      'This app asks your wallet for eleven things from three cards — your school, college and university records — enough to confirm all three belong to you and that each result meets the published bar. Not your National ID, not your name, not a single subject mark.',
    startLabel: 'Start the application',
    cancelLabel: 'Cancel this application',
    againLabel: 'Run another application',
    nothingLine: 'Nothing was disclosed and no decision was produced.',
    cancelledLine: 'The application was cancelled. Nothing was disclosed and no decision was produced.',
    expiredLine:
      'No presentation arrived before the request expired. Nothing was disclosed and no decision was produced.',
    approved: 'ELIGIBLE',
    rejectedLabel: 'REJECTED / UNABLE TO VERIFY',
    nested: true,
    rule: true,
    headline: true,
    withheld: EDUCATION_WITHHELD,
  },
  'education-job': {
    api: `${BASE}/api/verifier/education/job`,
    eyebrow: 'EMPLOYER — SOFTWARE ENGINEER HIRING',
    title: 'Apply for a Software Engineer role',
    lede:
      'This app asks your wallet for nine things from three cards — enough to confirm the three records belong to you, that each qualification is finished, and that your degree meets the bar. This role does not use your school or college percentage, so it is not requested at all.',
    startLabel: 'Start the application',
    cancelLabel: 'Cancel this application',
    againLabel: 'Run another application',
    nothingLine: 'Nothing was disclosed and no decision was produced.',
    cancelledLine: 'The application was cancelled. Nothing was disclosed and no decision was produced.',
    expiredLine:
      'No presentation arrived before the request expired. Nothing was disclosed and no decision was produced.',
    approved: 'ELIGIBLE',
    rejectedLabel: 'REJECTED / UNABLE TO VERIFY',
    nested: true,
    rule: true,
    headline: true,
    // The job channel additionally never receives the school or college
    // percentage — it does not request them. Listed first because that asymmetry
    // between the two portals is the clearest privacy evidence in the iteration.
    withheld: ['school percentage', 'college percentage', ...EDUCATION_WITHHELD],
  },
};

const COLOURS = {
  ivory: '#FDF9F0',
  ink: '#2E2A25',
  muted: '#7A736A',
  hairline: '#E5DED1',
  terracotta: '#B5502A',
  approved: '#1F6B4A',
  denied: '#540F3B',
  failed: '#A85236',
};

/** The seven checks the verifier service reports. Displayed, never evaluated. */
function Checks({ checks }) {
  const names = Object.keys(checks || {});
  if (!names.length) return null;
  return (
    <View style={styles.pills}>
      {names.map((name) => (
        <Text key={name} style={[styles.pill, checks[name] === 'OK' ? styles.pillOk : styles.pillBad]}>
          {name} {checks[name] === 'OK' ? '✓' : '✗'}
        </Text>
      ))}
    </View>
  );
}

/**
 * One threshold, against what was actually presented.
 *
 * Every value arrives ALREADY FORMATTED from the service — `verified[role].percentage`
 * and `shortfall.actual` both carry their own '%'. This app must not be able to
 * render a percentage differently from the service that decided on it, which is
 * the same rule the bank's money follows.
 */
function Rule({ thresholds, verified, shortfall }) {
  const roles = Object.keys(thresholds || {});
  if (!roles.length) return null;
  return (
    <View style={styles.calc}>
      {roles.map((role) => {
        const short = shortfall?.role === role;
        const met = verified?.[role]?.percentage;
        return (
          <View key={role} style={styles.calcLine}>
            <Text style={styles.calcKey}>
              {role} — requires {thresholds[role]}%
            </Text>
            <Text style={[styles.calcValue, short && { color: COLOURS.failed }]}>
              {short ? `${shortfall.actual} — short` : met ? `${met} — met` : 'not reached'}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** One line of the bank's working. Values arrive formatted; nothing is computed. */
function Calc({ label, value, total }) {
  return (
    <View style={styles.calcLine}>
      <Text style={total ? styles.calcTotalKey : styles.calcKey}>{label}</Text>
      <Text style={total ? styles.calcTotalValue : styles.calcValue}>{value}</Text>
    </View>
  );
}

export default function App() {
  // Which channel this app IS. Baked in at build time by VERIFIER_USE_CASE (see
  // app.config.js), not chosen on screen: an Agriculture demo must not put an
  // Age option in front of a farmer, and an idle-screen picker does precisely
  // that. Same rule as the wallet's issuer directory.
  const useCase = USE_CASES[USE_CASE_NAME];
  const api = useRef(useCase.api);

  const [phase, setPhase] = useState('idle');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(null);
  const session = useRef(null);
  const timers = useRef([]);

  const stop = useCallback(() => {
    timers.current.forEach(clearInterval);
    timers.current = [];
  }, []);

  useEffect(() => stop, [stop]);

  const finish = useCallback(
    (nextPhase, body) => {
      stop();
      setResult(body ?? null);
      setPhase(nextPhase);
    },
    [stop],
  );

  const poll = useCallback(async () => {
    if (!session.current) return;
    try {
      const res = await fetch(`${api.current}/sessions/${session.current}`);
      const body = res.status === 404 ? { state: 'expired' } : await res.json();
      switch (body.state) {
        case 'waiting':
          return;
        case 'decided':
          return finish('decided', body);
        case 'declined':
        case 'cancelled':
          return finish('nothing', body);
        case 'expired':
          return finish('nothing', { reason: useCase.expiredLine });
        default:
          return finish('rejected', body);
      }
    } catch (err) {
      finish('error', null);
      setError(`Could not reach the verifier service: ${err.message}`);
    }
  }, [finish]);

  const start = useCallback(async () => {
    setError(null);
    setResult(null);
    setPhase('starting');
    // Pinned for the whole run: the timers below must keep polling the namespace
    // this session was created in, even if the picker is touched afterwards.
    try {
      const res = await fetch(`${api.current}/sessions${useCase.sessionQuery ?? ''}`, { method: 'POST' });
      if (res.status !== 201) throw new Error(`the verifier service answered ${res.status}`);
      const body = await res.json();
      session.current = body.sessionId;
      setSecondsLeft(body.expiresInSeconds ?? null);
      setPhase('waiting');

      // Hand the request to the wallet. Same openid4vp:// URL the web page puts
      // in its QR — the wallet cannot tell which channel asked, which is the
      // point of a standards deep link.
      //
      // Deliberately NOT gated on canOpenURL: under Android 11+ package
      // visibility that answers false unless the scheme is declared in <queries>
      // (see plugins/with-openid4vp-query.js), and it answered false on a device
      // with the wallet installed and handling openid4vp:// correctly. openURL
      // is the call that matters, and it fails loudly enough on its own.
      try {
        await Linking.openURL(body.qrData);
      } catch {
        throw new Error('No wallet on this device could open the request. Is the wallet installed?');
      }

      timers.current.push(setInterval(poll, POLL_MS));
      timers.current.push(
        setInterval(() => setSecondsLeft((n) => (typeof n === 'number' && n > 0 ? n - 1 : 0)), 1000),
      );
    } catch (err) {
      stop();
      setPhase('error');
      setError(err.message);
    }
  }, [poll, stop]);

  /**
   * Give up on this request.
   *
   * A wallet that declines posts nothing back, so the service cannot tell a
   * refusal from silence — the verifier has to decide to stop waiting. Told to
   * the service rather than handled locally, so the session genuinely will not
   * report a decision afterwards.
   */
  const cancel = useCallback(async () => {
    const id = session.current;
    stop();
    if (id) {
      try {
        await fetch(`${api.current}/sessions/${id}/cancel`, { method: 'POST' });
      } catch {
        // The screen is honest either way: nothing was shared.
      }
    }
    setResult({ reason: useCase.cancelledLine });
    setPhase('nothing');
  }, [stop]);

  const reset = () => {
    stop();
    session.current = null;
    setResult(null);
    setError(null);
    setPhase('idle');
  };

  // The service's own decision, relabelled for reading and nothing more. The two
  // channels use different words for the same three outcomes, and the third —
  // "we could not trust what we were shown" — must never read as the second:
  // NOT ELIGIBLE means the claims were verified and the answer was no.
  const decided = phase === 'decided' ? result?.decision : null;
  const verdict =
    phase === 'decided'
      ? useCase.headline && decided === useCase.approved && result?.headline
        ? // PRODUCT's exact words, from the service. 'ELIGIBLE' alone would be a
          // paraphrase, and the distinction between eligibility and admission is
          // the thing PRODUCT is most explicit about.
          result.headline
        : String(decided ?? '').replace(/_/g, ' ')
      : phase === 'nothing'
        ? 'NO DATA SHARED'
        : useCase.rejectedLabel;
  const verdictColour =
    decided === useCase.approved
      ? COLOURS.approved
      : decided === 'DENIED' || decided === 'NOT_ELIGIBLE'
        ? COLOURS.denied
        : phase === 'nothing'
          ? COLOURS.muted
          : COLOURS.failed;

  /** The issuers behind the answer; agriculture returns two. */
  const issuers = Array.isArray(result?.issuer) ? result.issuer.join(' · ') : result?.issuer;

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.brand}>sunbird</Text>
        <Text style={styles.eyebrow}>{useCase.eyebrow}</Text>
        <Text style={styles.title}>{useCase.title}</Text>
        <Text style={styles.lede}>{useCase.lede}</Text>

        {phase === 'idle' && (
          <Pressable style={styles.primary} onPress={start}>
            <Text style={styles.primaryText}>{useCase.startLabel}</Text>
          </Pressable>
        )}

        {(phase === 'starting' || phase === 'waiting') && (
          <View style={styles.card}>
            <ActivityIndicator color={COLOURS.terracotta} />
            <Text style={styles.waiting}>
              {phase === 'starting' ? 'Asking the verifier service…' : 'Waiting for your wallet…'}
            </Text>
            {typeof secondsLeft === 'number' && phase === 'waiting' && (
              <Text style={styles.muted}>{secondsLeft}s left</Text>
            )}
            {phase === 'waiting' && (
              <Pressable style={styles.secondary} onPress={cancel}>
                <Text style={styles.secondaryText}>{useCase.cancelLabel}</Text>
              </Pressable>
            )}
          </View>
        )}

        {(phase === 'decided' || phase === 'nothing' || phase === 'rejected') && (
          <View style={styles.card}>
            <Text style={styles.eyebrow}>
              {phase === 'decided' ? 'VERIFIED RESULT' : phase === 'nothing' ? 'NO RESULT' : 'UNABLE TO VERIFY'}
            </Text>
            <Text style={[styles.verdict, { color: verdictColour }]}>{verdict}</Text>
            {!!result?.reason && <Text style={styles.reason}>{result.reason}</Text>}

            {/* The arithmetic, shown rather than asserted — and taken whole from
                the service. A loan amount with no visible derivation is
                indistinguishable from a hardcoded one. */}
            {!!result?.loan && !!result?.disclosed && (
              <View style={styles.calc}>
                <Calc label="Crop" value={result.disclosed.cropType} />
                {/* `cultivatedArea`, not `cultivatedAreaAcres`. The service has only ever
                    emitted the former (see services/bank-web/app.js, which renders the same
                    number correctly); the latter read `undefined`, and React renders that as
                    the string "undefined" rather than failing, so the verdict card showed
                    "undefined acres" on camera. */}
                <Calc label="Cultivated area" value={`${result.disclosed.cultivatedArea} acres`} />
                <Calc
                  label="Applicable rate"
                  value={`${result.loan.ratePerAcreFormatted} per acre`}
                />
                <Calc label="Maximum loan" value={result.loan.maximumLoanFormatted} total />
              </View>
            )}

            {!!issuers && (
              <View style={styles.row}>
                <Text style={styles.rowKey}>{Array.isArray(result?.issuer) ? 'ISSUERS' : 'ISSUER'}</Text>
                <Text style={styles.rowValue}>{issuers}</Text>
              </View>
            )}
            {/* The rule, shown rather than asserted: every threshold this policy
                declared against what was presented, so a NOT ELIGIBLE verdict
                names the single number that fell short. */}
            {!!useCase.rule && !!result?.thresholds && (
              <Rule
                thresholds={result.thresholds}
                verified={result.verified}
                shortfall={result.shortfall}
              />
            )}

            {!!result?.learnerId && (
              <View style={styles.row}>
                <Text style={styles.rowKey}>LEARNER</Text>
                <Text style={styles.rowValue}>
                  {result.learnerId} — correlated across all three
                </Text>
              </View>
            )}

            {!!result?.disclosed && (
              <View style={styles.row}>
                <Text style={styles.rowKey}>SHARED WITH US</Text>
                <View style={styles.pills}>
                  {/* Education returns `disclosed` keyed by credential, so it is
                      rendered per credential. Flattening it would print
                      '[object Object]' — and, worse, would hide that `learnerId`
                      arrives three times, which is the correlation the verifier
                      checked and the one fact this screen most needs to show. */}
                  {useCase.nested
                    ? Object.entries(result.disclosed).flatMap(([role, claims]) =>
                        Object.entries(claims || {}).map(([k, v]) => (
                          <Text key={`${role}.${k}`} style={[styles.pill, styles.pillShared]}>
                            {role} {k} = {String(v)}
                          </Text>
                        )),
                      )
                    : Object.entries(result.disclosed).map(([k, v]) => (
                        <Text key={k} style={[styles.pill, styles.pillShared]}>
                          {k} = {String(v)}
                        </Text>
                      ))}
                  {/* What was deliberately NOT received. The privacy claim is
                      only legible if the absence is named. */}
                  {useCase.withheld.map((name) => (
                    <Text key={name} style={[styles.pill, styles.pillWithheld]}>
                      {name}
                    </Text>
                  ))}
                </View>
              </View>
            )}
            {phase === 'nothing' && <Text style={styles.muted}>{useCase.nothingLine}</Text>}
            <Checks checks={result?.checks} />

            <Pressable style={styles.secondary} onPress={reset}>
              <Text style={styles.secondaryText}>{useCase.againLabel}</Text>
            </Pressable>
          </View>
        )}

        {phase === 'error' && (
          <View style={styles.card}>
            <Text style={[styles.verdict, { color: COLOURS.failed }]}>NOT VERIFIED</Text>
            <Text style={styles.reason}>{error}</Text>
            <Pressable style={styles.secondary} onPress={reset}>
              <Text style={styles.secondaryText}>Try again</Text>
            </Pressable>
          </View>
        )}

        <Text style={styles.footer}>
          Synthetic demonstration data. The decision is made by the verifier service, not by this
          app.
        </Text>
        <Text style={styles.footer}>{BASE.replace(/^https?:\/\//, '')}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLOURS.ivory },
  // paddingBottom clears the system navigation bar. The Age and Agriculture
  // results were short enough never to reach it; Education's is not — eleven
  // disclosed claims, twelve withheld ones and eight verification pills — so the
  // last pills and the reset button sat underneath it, reachable only by
  // over-scrolling. Found by scrolling to the bottom on the device.
  scroll: { padding: 24, paddingTop: 64, paddingBottom: 96, gap: 12 },
  brand: { color: COLOURS.terracotta, fontSize: 18, fontWeight: '700' },
  eyebrow: { color: COLOURS.muted, fontSize: 12, letterSpacing: 1.2, fontWeight: '700' },
  title: { color: COLOURS.ink, fontSize: 32, fontWeight: '800', marginTop: 4 },
  lede: { color: COLOURS.muted, fontSize: 15, lineHeight: 22, marginBottom: 8 },
  primary: {
    backgroundColor: COLOURS.terracotta,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  secondary: {
    borderWidth: 1,
    borderColor: COLOURS.hairline,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 16,
  },
  secondaryText: { color: COLOURS.ink, fontSize: 15, fontWeight: '600' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLOURS.hairline,
    padding: 20,
    gap: 6,
  },
  waiting: { color: COLOURS.ink, fontSize: 16, fontWeight: '600', marginTop: 8 },
  muted: { color: COLOURS.muted, fontSize: 13 },
  verdict: { fontSize: 34, fontWeight: '800', marginVertical: 4 },
  reason: { color: COLOURS.muted, fontSize: 14, lineHeight: 20 },
  row: { marginTop: 10 },
  rowKey: { color: COLOURS.muted, fontSize: 12, letterSpacing: 0.6, fontWeight: '700' },
  rowValue: { color: COLOURS.ink, fontSize: 15, fontWeight: '600' },
  calc: {
    backgroundColor: '#FFFDF7',
    borderWidth: 1,
    borderColor: COLOURS.hairline,
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
    gap: 8,
  },
  calcLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  calcKey: { color: COLOURS.muted, fontSize: 14 },
  calcValue: { color: COLOURS.ink, fontSize: 15, fontWeight: '700' },
  calcTotalKey: { color: COLOURS.ink, fontSize: 15, fontWeight: '700' },
  calcTotalValue: { color: COLOURS.approved, fontSize: 22, fontWeight: '800' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  pillShared: { backgroundColor: '#FBF0D8', color: COLOURS.ink },
  pillWithheld: {
    backgroundColor: '#F4F1EA',
    color: COLOURS.muted,
    textDecorationLine: 'line-through',
  },
  pill: { fontSize: 11, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, overflow: 'hidden' },
  pillOk: { backgroundColor: '#E8F2EC', color: COLOURS.approved },
  pillBad: { backgroundColor: '#F6E7E1', color: COLOURS.failed },
  footer: { color: COLOURS.muted, fontSize: 11, marginTop: 18, lineHeight: 16 },
});
