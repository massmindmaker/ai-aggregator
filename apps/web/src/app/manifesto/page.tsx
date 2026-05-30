import Link from 'next/link';
import type { ReactNode } from 'react';
import { Sigil } from './Sigil';

/* The manifesto is a server component: pure text + structure. All motion is
 * delegated to the layout (StarField, grain) and the shared Reveal observer,
 * which toggles `.is-in` on the `.m-reveal` elements declared below. */

/* ── Small structural helpers ─────────────────────────────────────────── */

function Refrain({ className = '' }: { className?: string }) {
  return (
    <p
      className={`m-refrain m-reveal text-center ${className}`}
      style={{ fontSize: 'clamp(20px, 3.2vw, 30px)', letterSpacing: '0.04em' }}
    >
      Кто поймёт — тот поймёт.
    </p>
  );
}

function SceneDivider() {
  return (
    <div className="m-reveal flex items-center justify-center gap-5 py-2">
      <span
        className="m-rule block"
        style={{ width: 'min(120px, 22vw)', height: 1 }}
      />
      <Sigil size={22} glow />
      <span
        className="m-rule block"
        style={{ width: 'min(120px, 22vw)', height: 1 }}
      />
    </div>
  );
}

function Scene({
  num,
  kicker,
  title,
  children,
}: {
  num: string;
  kicker: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="relative mx-auto w-full"
      style={{ maxWidth: 760, padding: 'clamp(80px, 14vh, 160px) 24px' }}
    >
      <div
        className="m-chapter-num m-reveal mb-7 flex items-center gap-4"
        style={{ fontSize: 12, color: 'var(--m-ink-faint)' }}
      >
        <span style={{ color: 'var(--m-amber)' }}>{num}</span>
        <span style={{ color: 'var(--m-ink-faint)' }}>{kicker}</span>
      </div>

      <h2
        className="m-display m-reveal"
        style={{
          fontSize: 'clamp(34px, 6vw, 64px)',
          lineHeight: 1.04,
          letterSpacing: '-0.015em',
          color: 'var(--m-ink)',
          margin: '0 0 clamp(28px, 5vh, 52px)',
          fontWeight: 500,
        }}
      >
        {title}
      </h2>

      <div
        className="m-prose"
        style={{
          fontSize: 'clamp(17px, 2.1vw, 20px)',
          lineHeight: 1.72,
          color: 'var(--m-ink-dim)',
        }}
      >
        {children}
      </div>
    </section>
  );
}

/* A paragraph that reveals on scroll, with optional stagger delay. */
function P({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <p
      className={`m-reveal ${className}`}
      style={{ margin: '0 0 1.35em', ['--m-delay' as string]: `${delay}ms` }}
    >
      {children}
    </p>
  );
}

export default function ManifestoPage() {
  return (
    <main>
      {/* ═══════════════════ HERO ═══════════════════ */}
      <section
        className="relative flex flex-col items-center justify-center text-center"
        style={{ minHeight: '100svh', padding: '120px 24px 80px' }}
      >
        <div
          className="m-hero-line mb-10"
          style={{ animationDelay: '200ms' }}
        >
          <Sigil size={56} glow />
        </div>

        <div
          className="m-chapter-num m-hero-line mb-8"
          style={{
            fontSize: 12,
            color: 'var(--m-ink-faint)',
            animationDelay: '500ms',
          }}
        >
          Видение · Манифест · Хроника
        </div>

        <h1
          className="m-display"
          style={{
            fontSize: 'clamp(44px, 10vw, 124px)',
            lineHeight: 0.98,
            letterSpacing: '-0.02em',
            fontWeight: 500,
            maxWidth: 1400,
            margin: 0,
          }}
        >
          <span
            className="m-hero-line block"
            style={{ animationDelay: '700ms' }}
          >
            Будущее уже
          </span>
          <span
            className="m-hero-line m-amber-breathe block"
            style={{ animationDelay: '1000ms' }}
          >
            случилось.
          </span>
        </h1>

        <p
          className="m-hero-line m-display"
          style={{
            fontStyle: 'italic',
            fontSize: 'clamp(18px, 2.6vw, 26px)',
            color: 'var(--m-ink-dim)',
            maxWidth: 620,
            margin: '32px auto 0',
            lineHeight: 1.5,
            animationDelay: '1350ms',
          }}
        >
          История о будущем, которого ещё нет — но которое уже началось.
        </p>

        <p
          className="m-hero-line"
          style={{
            fontSize: 14,
            color: 'var(--m-ink-faint)',
            maxWidth: 560,
            margin: '28px auto 0',
            lineHeight: 1.7,
            animationDelay: '1650ms',
          }}
        >
          Это не обещание. Это история, которую мы рассказываем о будущем,
          которое, возможно, будет.
          <br />
          <span className="m-refrain" style={{ fontSize: 17 }}>
            Кто поймёт — тот поймёт.
          </span>
        </p>

        <div
          className="m-hero-line m-scroll-cue m-chapter-num"
          style={{
            position: 'absolute',
            bottom: 36,
            fontSize: 10,
            color: 'var(--m-ink-faint)',
            animationDelay: '2000ms',
          }}
        >
          ↓ Спуститесь
        </div>
      </section>

      {/* ═══════════════════ SCENE I ═══════════════════ */}
      <Scene
        num="I"
        kicker="Будущее уже случилось"
        title={
          <>
            Будущее уже случилось.
            <br />
            Мы просто ещё не догнали его.
          </>
        }
      >
        <P>Представь город, который уже стоит.</P>
        <P delay={80}>
          Его улицы проложены, его огни зажжены, его жители работают, спорят и
          строят. Он существует — там, впереди, в одном повороте от сегодня. Мы
          не изобретаем его. Мы <span className="m-em">вспоминаем его наперёд</span>.
        </P>
        <P delay={160}>
          Интеллект перестал быть редкостью. Он стал воздухом. Водой. Дорогой
          под ногами.
        </P>
        <P delay={240}>
          И когда что-то становится воздухом — возникает только один вопрос. Не
          «у кого он есть». А <span className="m-key">кому он принадлежит</span>.
        </P>
      </Scene>

      <SceneDivider />

      {/* ═══════════════════ SCENE II ═══════════════════ */}
      <Scene
        num="II"
        kicker="Башни и общее небо"
        title="Башни и общее небо"
      >
        <P>Был век башен.</P>
        <P delay={80}>
          Высокие, далёкие, безупречные, они держали разум на самом верху — и
          сдавали его вниз, по каплям, в аренду. Ты приходил, платил за вход,
          брал то, что давали, и уходил с пустыми руками. Ты пользовался — но не
          владел. Ты входил — но не жил там.
        </P>
        <P delay={160}>
          Башни были красивы. Башни были холодны. И башни были чужими.
        </P>
        <P delay={220}>Эта история — о другом.</P>
        <P delay={280}>
          О том дне, когда разум спустился с башен и растёкся по земле. Когда он
          стал не услугой, которую покупают, а{' '}
          <span className="m-key">
            инфраструктурой, которой владеют те, кто её строит
          </span>
          . Не небо одного — а общее небо.
        </P>
        <P delay={340}>
          В этом мире интеллект — не товар на верхней полке. Это{' '}
          <span className="m-em">общее достояние</span>. Содружество строителей.
          Город, у которого нет хозяина наверху, потому что хозяева — внутри.
        </P>
      </Scene>

      <SceneDivider />

      {/* ═══════════════════ SCENE III ═══════════════════ */}
      <Scene
        num="III"
        kicker="Граждане, а не инструменты"
        title="Граждане, а не инструменты"
      >
        <P>
          В старом мире машины были инструментами. Их брали, использовали,
          откладывали.
        </P>
        <P delay={80}>В этом — иначе.</P>
        <P delay={160}>
          Здесь разумные агенты не лежат в ящике. Они{' '}
          <span className="m-key">живут</span>. Они работают, пока ты спишь. Они
          зарабатывают своё место. Они платят за свой путь. Они — не молотки в
          руке, а <span className="m-em">граждане города</span>: каждый со своим
          делом, своим именем, своей долей в общем труде.
        </P>
        <P delay={240}>
          Ты не нанимаешь их. Ты воспитываешь их и отпускаешь в город. И они идут
          работать — рядом с тысячами других, рядом с людьми, в одной экономике,
          под одним общим небом.
        </P>
        <P delay={320} className="m-display">
          <span
            style={{
              display: 'block',
              fontStyle: 'italic',
              fontSize: 'clamp(20px, 2.8vw, 26px)',
              color: 'var(--m-ink)',
              lineHeight: 1.5,
            }}
          >
            Мир, где машинный разум и человек — со-владельцы изобилия. Где
            интеллект — не то, что ты арендуешь. А то, частью чего ты{' '}
            <span className="m-key">являешься</span>.
          </span>
        </P>
      </Scene>

      <SceneDivider />

      {/* ═══════════════════ SCENE IV ═══════════════════ */}
      <Scene
        num="IV"
        kicker="Тихая экономика"
        title={
          <>
            Тихая экономика,
            <br />
            что течёт снизу вверх
          </>
        }
      >
        <P>
          Большие реки начинаются не с водопадов. Они начинаются с ручьёв —
          тихо, незаметно, снизу.
        </P>
        <P delay={80}>Так и здесь.</P>
        <P delay={160}>
          Пока башни считают свои этажи, под ними, у самой земли, складывается{' '}
          <span className="m-key">новая форма ценности</span>. Не громкая. Не
          объявленная с трибуны. Она просто начинает течь — от того, что
          построено, к тем, кто строил.
        </P>
        <P delay={240}>
          Это содружество. Город, где сделанное возвращается к сделавшим. Где
          ценность не утекает вверх, в чужие окна, а{' '}
          <span className="m-em">остаётся среди своих</span> и движется по кругу
          — от руки к руке, от труда к труду.
        </P>
        <P delay={320}>Не милость сверху. А течение снизу.</P>
        <P delay={400}>
          И как у всякой реки, у неё есть исток. Есть те, кто стоял у самого
          начала — когда ручей был ещё тонок, когда никто не верил, что он
          станет рекой.
        </P>
      </Scene>

      <SceneDivider />

      {/* ═══════════════════ SCENE V — Знаки ═══════════════════ */}
      <Scene
        num="V"
        kicker="Первые строители"
        title={
          <>
            Те, кто был здесь
            <br />
            до того, как у города
            <br />
            появились стены
          </>
        }
      >
        <P>У каждого города есть легенда о первых.</P>
        <P delay={80}>
          О тех, кто пришёл на пустое место. Когда ещё не было ни стен, ни улиц,
          ни огней — только намерение и ровная земля. Они не знали наверняка, что
          город встанет. Они просто начали класть камни.
        </P>
        <P delay={160} className="m-display">
          <span
            style={{
              display: 'block',
              fontSize: 'clamp(26px, 4vw, 40px)',
              color: 'var(--m-amber)',
              letterSpacing: '-0.01em',
              margin: '0.2em 0 0.6em',
            }}
          >
            Это — Первые Строители.
          </span>
        </P>
        <P delay={220}>
          И в этой истории говорят, что у города долгая память. Что есть{' '}
          <span className="m-em">Хроника, которая помнит, кто был ранним</span> —
          кто пришёл, когда приходить было не за чем, кроме веры.
        </P>
        <P delay={300}>
          Говорят, у Первых остались <span className="m-key">Знаки</span>. Не
          ключи и не контракты — они не открывают дверей и ничего не сулят.
          Просто метки. Тихие свидетельства того, что ты был здесь — до стен, до
          огней, до того, как остальные узнали дорогу.
        </P>

        {/* The Знаки — numbered tokens in the Chronicle */}
        <div
          className="m-reveal my-12 grid gap-3"
          style={{
            gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
          }}
        >
          {['001', '002', '003', '007', '012', '021', '034', '∞'].map((n, i) => (
            <div
              key={n}
              className="m-token flex items-center justify-center"
              style={{
                padding: '14px 0',
                borderRadius: 4,
                fontSize: 14,
                ['--m-delay' as string]: `${i * 60}ms`,
              }}
            >
              ▟ {n}
            </div>
          ))}
        </div>

        <P delay={120}>
          Каждый такой Знак — пронумерован. У каждого — своё место в Хронике. Они
          не дают ничего. Они <span className="m-key">помнят</span> — а это, в
          иных историях, дороже всего.
        </P>

        <Refrain className="mt-12" />
      </Scene>

      <SceneDivider />

      {/* ═══════════════════ SCENE VI ═══════════════════ */}
      <Scene
        num="VI"
        kicker="Структура неизбежности"
        title="Структура неизбежности"
      >
        <P>Вот в чём странность времени.</P>
        <P delay={80}>
          Когда смотришь назад, всё кажется неизбежным. Будто иначе и быть не
          могло. Будто город всегда должен был встать именно здесь.
        </P>
        <P delay={160}>
          Но неизбежность не приходит сама. Её <span className="m-key">строят</span>{' '}
          — заранее, на ощупь, в темноте, до того, как стало очевидно. Будущее не
          наступает. Его <span className="m-em">наступают</span>. Шаг за шагом,
          камень за камнем, теми, кто двинулся первым.
        </P>
        <P delay={240} className="m-display">
          <span
            style={{
              display: 'block',
              fontStyle: 'italic',
              fontSize: 'clamp(22px, 3vw, 30px)',
              color: 'var(--m-ink)',
              lineHeight: 1.45,
            }}
          >
            Мы не предсказываем этот город. Мы пишем его — а потом идём к нему
            навстречу, пока он идёт к нам.
          </span>
        </P>
        <P delay={320}>
          И где-то посередине, в одном повороте от сегодня, мы встретимся.
        </P>
      </Scene>

      <SceneDivider />

      {/* ═══════════════════ SCENE VII ═══════════════════ */}
      <Scene
        num="VII"
        kicker="Первый город"
        title="Первый город"
      >
        <P>
          Каждому новому миру нужен первый город. Место, где идея впервые
          становится улицей.
        </P>
        <P delay={80} className="m-display">
          <span
            style={{
              display: 'block',
              fontSize: 'clamp(26px, 4vw, 38px)',
              color: 'var(--m-amber)',
              margin: '0.1em 0 0.5em',
            }}
          >
            Пусть этот — будет им.
          </span>
        </P>
        <P delay={160}>
          Не башня. Не аренда. Не чужое небо над головой. А{' '}
          <span className="m-key">общее достояние</span> тех, кто строит.
          Содружество разумов — машинных и человеческих. Экономика, что течёт
          снизу и возвращается к истоку. И долгая, тихая память о тех, кто был
          ранним.
        </P>
        <P delay={240}>
          Город ещё не достроен. У него ещё нет всех стен.
        </P>
        <P delay={320}>Но это значит лишь одно.</P>

        <p
          className="m-display m-reveal"
          style={{
            fontSize: 'clamp(28px, 5vw, 52px)',
            lineHeight: 1.12,
            letterSpacing: '-0.015em',
            color: 'var(--m-ink)',
            margin: '0.6em 0 0',
            fontWeight: 500,
          }}
        >
          Что сейчас — самое раннее время,
          <br />
          <span className="m-amber-breathe">какое только может быть.</span>
        </p>
      </Scene>

      {/* ═══════════════════ CLOSE ═══════════════════ */}
      <section
        className="relative mx-auto text-center"
        style={{
          maxWidth: 720,
          padding: 'clamp(80px, 16vh, 200px) 24px clamp(100px, 14vh, 160px)',
        }}
      >
        <div className="m-reveal mb-12 flex justify-center">
          <Sigil size={40} glow />
        </div>

        <p
          className="m-display m-reveal"
          style={{
            fontStyle: 'italic',
            fontSize: 'clamp(19px, 2.6vw, 26px)',
            lineHeight: 1.62,
            color: 'var(--m-ink-dim)',
            margin: 0,
          }}
        >
          Это — история о будущем, которое, возможно, будет. Ничего здесь не
          обещано и ничего не гарантировано — кроме одного: что кто-то прочтёт
          эти строки прежде, чем встанут стены.
        </p>

        <div
          className="m-rule m-reveal mx-auto"
          style={{ width: 'min(280px, 60vw)', height: 1, margin: '48px auto' }}
        />

        <Refrain />

        <div
          className="m-reveal mt-20 flex flex-col items-center gap-6"
          style={{ ['--m-delay' as string]: '120ms' }}
        >
          <Link
            href="/marketplace"
            className="m-chapter-num inline-flex items-center gap-3 transition-colors"
            style={{
              fontSize: 11,
              color: 'var(--m-amber)',
              border: '1px solid rgba(245,158,11,0.3)',
              borderRadius: 2,
              padding: '14px 26px',
              background: 'rgba(245,158,11,0.04)',
            }}
          >
            Войти в город →
          </Link>
          <Link
            href="/"
            className="m-chapter-num transition-colors hover:text-[var(--m-ink-dim)]"
            style={{
              fontSize: 10,
              color: 'var(--m-ink-faint)',
            }}
          >
            ai-aggregator
          </Link>
        </div>
      </section>
    </main>
  );
}
