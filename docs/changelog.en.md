# Release notes

> Moved out of the [README](../README.en.md). The front page keeps one line about the current
> release; the ledgers live here, newest first. Every version also has a
> [GitHub Release](https://github.com/PandaPolo/dsh-voice-call/releases) page.
>
> 中文版：[changelog.md](changelog.md)

## 🆕 What changed in 0.3.7

"The agent stopped to ask you something" and "the agent stopped forever" used to look identical: the harness puts **no timeout** on a question (there is not a single timer in `dsh-user-questions`), and an agent parked on one cannot nudge you — its loop is stopped. So if you walked away for five minutes, it waited five minutes.

This release has the plugin watch the clock on its behalf:

| What you would notice | Now |
|---|---|
| A question appears and you walk away | after the patience (5 minutes by default, 1/5/10/30 selectable) a call card appears: "有 2 个关于「部署方案」的问题在等你回答，已经等了 5 分钟" |
| You want to hear it | press **接听**: it reads one sentence naming what is waiting, then the card retires |
| You go back and answer in the chat | the card **takes itself down**; nothing to dismiss |
| You press 拒接/稍后再说 on the card | that only silences the card. **It never answers for you** — the question is still there |
| A batch holds two unrelated questions | it reports the count ("有 2 个问题") instead of labelling the batch with the first question's title |
| The card appears with no sound | the card now says why: "浏览器拦住了铃声 —— 点一下这个页面就会响". A browser that refuses autoplay always recovered on the first click; what was missing was being told |

It ships **off**: turn on 「等问题振铃（实验性新功能）」 in the settings card, and pick the patience on the same row.

This release also fences two ways the plugin could take the host down — both surfaced by this experiment. A card's answer is handled inside a web route, so an exception thrown there used to become a process-level uncaught exception and kill `dsh web` (it is now fenced and answers with a reason). And the plugin's own config schema had **no test** that walked the host's validation at all — one `volatile` inside another `volatile` is enough to stop the plugin from activating at all, while 270 tests stayed green. Both classes are now covered by tests.

One more: the settings row 「振铃超时（秒）」 is now 「**铃声持续时间**」. Not a byte of behaviour changed; the old name read as though it governed something else.

---

## 0.3.6 / 0.3.5 — the bill, and three platforms

The previous release put the features in: one-click provisioning, eleven ringtones you can pick, the call card. This release is the bill paid afterwards — I went back through the backend line by line, and what I found was not broken features but **features that did not keep their promises**. Every one of them shipped with a green test suite, which is the actual lesson.

| What you would notice | Before | Now |
|---|---|---|
| Opening the settings card while a download runs | the progress bar is wiped and the card says "not installed" | looking is just looking; the run keeps its progress |
| Retrying an interrupted 1.9 GB download | it re-fetches the whole file (despite the 断点续传 label) | it resumes; segments already paid for are not paid for twice |
| Cancelling a call that is ringing | the card keeps ringing, up to ten minutes | the card comes down with the cancellation |
| Pressing 清理本地文件 | a loosely written `audioDir` could reach a `models/` belonging to something else | roots this plugin did not create are refused, with the reason shown |
| Any web page reaching this local port | one cross-site request could delete your models or answer a call for you | state-changing requests are origin-checked first |
| Deleting an audio file yourself, or holding one open | the whole chat UI could die with it | that one playback fails and everything else carries on |
| Recording from the microphone | the raw capture stayed in the OS temp dir forever | it is deleted afterwards, including when transcription fails |

The parts that were already kind to you stay where they were, unfurled and unhidden: **试听** next to the ringtone dropdown loops the tone you picked *at the volume the card will actually use*; the 运行环境 row takes its defaults from what the directory really holds; cleanup is a visible button that states its weight rather than a checkbox buried in advanced options.

---

**0.3.6** holds the same bar on three platforms: CI now runs Linux, Windows and macOS. It immediately found four problems that only exist on the other systems — the cleanup root check on Linux (it read `TMP/TEMP/TMPDIR` directly, and those are unset on Linux, so `/tmp` was not refused; it now asks `os.tmpdir()`), unpack fixtures whose fake engine binary had no executable bit, two tests written with Windows assumptions, and a macOS integration fake that no longer matched the harness seam it stands in for (the production runner was right all along). All 262 tests are green on all three, and the macOS pair is confirmed to actually run `say` and produce a readable audio file rather than being skipped into greenness.
