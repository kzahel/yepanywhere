import {
  parseVocabularyBaseline,
  rankVocabulary,
  type SpeechVocabularyStatus,
  VOCABULARY_BASELINE_URL,
} from "@yep-anywhere/shared";
import { Fragment, useEffect, useState } from "react";
import { ButtonBase } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import styles from "./SpeechVocabularyChart.module.css";

export default function SpeechVocabularyChart({
  status,
}: {
  status: SpeechVocabularyStatus;
}) {
  const { t } = useI18n();
  const [baseline, setBaseline] = useState<ReadonlyMap<string, number>>();
  const [error, setError] = useState<string>();
  const [distinctive, setDistinctive] = useState(true);
  const [minimum, setMinimum] = useState(6);
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    void fetch(VOCABULARY_BASELINE_URL, {
      signal: controller.signal,
      cache: "force-cache",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Vocabulary baseline: HTTP ${response.status}`);
        const frequencies = parseVocabularyBaseline(await response.text());
        if (!disposed) setBaseline(frequencies);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setError(error instanceof Error ? error.message : String(error));
          setDistinctive(false);
          setBaseline(new Map());
        }
      })
      .finally(() => clearTimeout(timer));
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  if (!baseline || !status.words) return <p>{t("speechVocabularyLoading")}</p>;
  const total = status.totals.user + status.totals.assistant;
  const ranked = rankVocabulary(
    status.words,
    total,
    baseline,
    minimum,
    distinctive,
  );
  const displayed = ranked.slice(0, 18);
  const unknown = distinctive
    ? rankVocabulary(status.words, total, baseline, minimum, false)
        .filter((word) => word.ratio === undefined)
        .slice(0, 8)
    : [];
  const selectedUnknown = unknown.find((word) => word.word === selected);
  const maximum = Math.max(1, ...displayed.map((word) => word.count));
  const maximumLogRatio = Math.max(
    1,
    ...displayed.map((word) => Math.log1p(word.ratio ?? 0)),
  );
  const description = (word: (typeof ranked)[number]) =>
    t("speechVocabularyWordDetail", {
      word: word.word,
      count: word.count,
      user: word.user,
      assistant: word.assistant,
    }) +
    " · " +
    (word.ratio === undefined
      ? t("speechVocabularyOutsideBaseline")
      : t("speechVocabularyRatio", { ratio: word.ratio.toFixed(1) }));

  return (
    <div className={styles.chart}>
      {error && (
        <p role="alert">
          {t("speechVocabularyBaselineError")} {error}
        </p>
      )}
      <table className={styles.table} aria-label={t("speechVocabularyView")}>
        <thead>
          <tr>
            <th scope="col">{t("speechVocabularyWordColumn")}</th>
            <th scope="col">{t("speechVocabularyCountColumn")}</th>
            <th scope="col">{t("speechVocabularyBaselineColumn")}</th>
          </tr>
        </thead>
        <tbody>
          {displayed.map((word) => (
            <Fragment key={word.word}>
              <tr
                data-selected={selected === word.word}
                title={description(word)}
              >
                <th scope="row">
                  <ButtonBase
                    className={styles.word}
                    aria-label={description(word)}
                    aria-pressed={selected === word.word}
                    onClick={() => setSelected(word.word)}
                    onFocus={() => setSelected(word.word)}
                  >
                    {word.word}
                  </ButtonBase>
                </th>
                <td>
                  <div className={styles.value}>
                    {word.count.toLocaleString()}
                    <span
                      className={styles.countBar}
                      aria-hidden="true"
                      style={{ width: `${(100 * word.count) / maximum}%` }}
                    >
                      <span
                        className={styles.userBar}
                        style={{ width: `${(100 * word.user) / word.count}%` }}
                      />
                      <span
                        className={styles.agentBar}
                        style={{
                          width: `${(100 * word.assistant) / word.count}%`,
                        }}
                      />
                    </span>
                  </div>
                </td>
                <td>
                  <div className={styles.value}>
                    {word.ratio === undefined ? (
                      "—"
                    ) : (
                      <>
                        {`${word.ratio.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })}×`}
                        <span
                          className={styles.ratioBar}
                          aria-hidden="true"
                          style={{
                            width: `${(100 * Math.log1p(word.ratio)) / maximumLogRatio}%`,
                          }}
                        />
                      </>
                    )}
                  </div>
                </td>
              </tr>
              {selected === word.word && (
                <tr>
                  <td colSpan={3} className={styles.detailCell}>
                    <p aria-live="polite">{description(word)}</p>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {displayed.length === 0 && <p>{t("speechVocabularyNoWords")}</p>}
      {unknown.length > 0 && (
        <div className={styles.unknown}>
          <p>{t("speechVocabularyOutsideBaseline")}</p>
          {unknown.map((word) => (
            <ButtonBase
              key={word.word}
              className={styles.unknownWord}
              aria-label={description(word)}
              aria-pressed={selected === word.word}
              onFocus={() => setSelected(word.word)}
              onClick={() => setSelected(word.word)}
              title={description(word)}
            >
              {word.word} · {word.count.toLocaleString()}
            </ButtonBase>
          ))}
          {selectedUnknown && (
            <p aria-live="polite">{description(selectedUnknown)}</p>
          )}
        </div>
      )}
      <div className={styles.controls}>
        <label>
          {t("speechVocabularyView")}
          <select
            value={distinctive ? "distinctive" : "frequent"}
            onChange={(event) =>
              setDistinctive(event.target.value === "distinctive")
            }
          >
            <option value="distinctive" disabled={!!error}>
              {t("speechVocabularyDistinctive")}
            </option>
            <option value="frequent">{t("speechVocabularyFrequent")}</option>
          </select>
        </label>
        <label>
          {t("speechVocabularyMinimum")}
          <input
            type="number"
            min="1"
            max="1000000"
            value={minimum}
            onChange={(event) =>
              setMinimum(
                Math.max(1, Math.min(1000000, Number(event.target.value) || 1)),
              )
            }
          />
        </label>
      </div>
      <p>{t("speechVocabularyChartGuide")}</p>
      <p>
        {t("speechVocabularyBaselineNote", { candidates: status.words.length })}{" "}
        <a
          href="https://github.com/hermitdave/FrequencyWords"
          target="_blank"
          rel="noreferrer"
        >
          FrequencyWords / OpenSubtitles 2018
        </a>
        {" · "}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noreferrer"
        >
          CC BY-SA 4.0
        </a>
      </p>
    </div>
  );
}
