# Measurements

What was measured on the test machines, and what was tried and left out. The engine and fan settings these
numbers led to are in [`llm-server/`](../llm-server).

- **LLM server:** Bosgame M5, Ryzen AI Max+ 395, 128 GB, board AXB35-02, BIOS 3.11, Fedora 44.
- **Portal server:** Pentium G4400T (2 cores), 8 GB, Fedora 45.
- One unit of each, at room temperature. Power and temperature are the chip's own sensors, not a wall meter.
- tok/s is tokens per second. Reading is prompt processing, writing is the answer.
- The fan, model, engine, image and full-machine measurements date from kernel 7.2.15 and were not repeated
  with 7.3.4.

## Settings and what they buy

| Setting | Value | Measured |
|---|---|---|
| UMA, the GPU's fixed memory | 512 MB | Linux sees 124.9 GiB. The machine shipped at 64 GB fixed, which leaves Linux about 62. |
| GTT limit, RAM the GPU may borrow | 124 GiB | The model and all four sessions sit on the GPU: 111.5 GiB in use. |
| IOMMU | off | Other owners report 5-15% faster prompt reading. Not compared here; every number was taken with it off. |
| Power profile | Performance | 120 W sustained, 160 W peak. 132 W can be forced but is slower. |
| Fan curve | up to 95% | Chip about 6 °C cooler. Reading holds 1,760-1,787 tok/s instead of sagging to as low as 1,484 after long load: up to 20% faster when hot. |
| CPU governor | performance | TuneD profile `accelerator-performance`. Baseline for all numbers. |
| CPU undervolt | Curve offset -50 | 9% more CPU work at 5 W less and 4 °C cooler. Prompt reading gains about 1%. |
| N-gram table | 8.5 bits a value (Q8_0) | Predicts like the full-precision table, which is 48 GB larger. Wikitext is predicted 0.3% better than with the 4.5-bit table of the Q4 files, code the same. Same memory and speed; 26 GB more on the SSD. |
| Speculative decoding | MTP | A helper file drafts tokens ahead and about 80% are accepted. Writing runs at 51 to 79 tok/s, half of the runs at 62 to 67 (99 runs with three n-gram tables, November 20 and 21, 2026), against 24 to 27 on llama.cpp without it. |

## Levers tried and left alone

`ryzenadj` comes with the [CPU undervolt](#cpu-undervolt); its settings last until the next reboot. Stock limits
(`sudo ryzenadj --info`): STAPM 120 W, fast limit 160 W, slow limit 140 W, temperature limit 98 °C.

| Lever | Result | Verdict |
|---|---|---|
| More power<br>`sudo ryzenadj --stapm-limit=140000` | The firmware caps the sustained limit at 132 W: ask for 140 and it reads back 132. At 132 W it was slower, 1,741 and 1,667 tok/s against 1,787 at 120 W. It drew 4-6 W more, ran 2-3 °C hotter and spent more time throttled at 98 °C. | slower |
| Higher temperature limit<br>`sudo ryzenadj --tctl-temp=100` | Reads back as 98 °C, the maximum this firmware allows. | locked |
| Lower temperature limit<br>`sudo ryzenadj --tctl-temp=90` | Works. The chip peaks at 90 °C and the fans run about 8% slower. Prompt reading drops 2.2%. A limit of 95 °C cost 3.6% in a second back-to-back test. | costs speed |
| Fans at 100% | Worse than 95%. Once hot, fan 1 slows to an average of 2,150 rpm while fan 2 holds 4,350, and the chip runs at 87-89 °C instead of 83. | worse |
| GPU overclock<br>`sudo ryzenadj --gfx-clk=3000` | `set_gfx_clk is rejected by SMU`. The driver's own limit is 2,900 MHz and it refuses 3,000 as well. Under AI load the GPU averages 2,680-2,750 MHz, below its cap. | locked |
| GPU clock forced to maximum | 1,739 tok/s, the same as stock. Idle power doubles from 7.5 to 15.6 W. | no gain |
| GPU undervolt<br>`sudo ryzenadj --set-cogfx=1048526` | `set_cogfx is not supported on this family` | locked |
| CPU overclock | No BIOS option, and `ryzenadj` has no clock or voltage control for this chip. | locked |
| RAM speed | Rated for 8,533 MT/s, runs at 8,000. The firmware sets that at power-on; there is no setting in the BIOS or in Linux. The most it could add is 6.7% writing speed. | locked |
| GPU job timeout<br>`amdgpu.lockup_timeout=60000` | Without it the full-load test passes, a 12-megapixel image is read, and the kernel logs no GPU timeout. | not needed |
| Repaste | Not tried. It means opening the case, and the fan curve already removes most of the throttling. | not tried |

## Fans

| Fan control | Chip in a long run | Prompt reading |
|---|---|---|
| Firmware | At 98 °C for 24-51% of the run; 86-94 °C average | Sags from about 1,740 to between 1,484 and 1,745 tok/s, depending on how warm the case already is (seven runs) |
| Held at 80, 90 or 95% | 83-89 °C average | 1,760-1,787 tok/s in all eight runs |

- Short jobs gain about 3%, long hot ones up to 20%. Writing speed does not change: it depends on memory
  bandwidth, not on temperature.
- The upstream driver's stock fan settings do nothing on BIOS 3.11: the firmware's top fan level is only about
  3,000 rpm.
- Fan speed by duty: 40% to 75%, about 2,500 to 3,800 rpm; 80%, about 3,900 rpm; 95%, about 4,300 rpm. With the
  firmware in control right after a load: 2,120 and 2,321 rpm.
- Burn-in on stock fans, 30 minutes of `stress-ng` on all cores and an hour of `stressapptest` over 108 GB:
  about 98 °C in the CPU test, about 95 °C in the RAM test. Both passed at full length on November 17, 2026.

## Power profiles

| Profile | Sustained / peak | Measured |
|---|---|---|
| `performance` | 120 W / 160 W | Every other number here. 121-128 W under load, about 7 W idle. |
| `balanced` | 85 W / 120 W | |
| `quiet` | 55 W / 100 W | Prompt reading 28% slower (1,312 tok/s). |

## CPU undervolt

In use on the test machine since November 18, 2026 (`llm-server/undervolt.service`). Of the other numbers in
this file only those of four 256K sessions were taken with it. The same 45-second all-core test, twice each way,
kernel 7.3.4:

| | Work | Clock | Power | Temperature |
|---|---|---|---|---|
| Stock | 23,369 and 23,395 operations a second | 4,540 MHz | 128 W | 98 °C, the chip's limit |
| Curve offset -50 | 25,481 and 25,477 | 4,950 MHz | 123 W | 94 °C |

- 9% more work at 5 W less and 4 °C cooler. Prompt reading gained about 1% on kernel 7.2.15, from 1,815 and
  1,819 tok/s to 1,836 and 1,832: the GPU does most of that work, and it has no such setting.
- -55 through -200 are accepted but behave exactly like -50 (kernel 7.2.15).
- With the offset on, November 18: all cores checked their arithmetic for 5 minutes and each of the 16 cores
  alone for 30 seconds, twice, without an error, and the tests of four 256K sessions under [Load](#load) ran.
  After a reboot the unit set the offset 8 seconds into the boot, and the same all-core test gave 25,490
  operations a second. It was not run for days.
- November 20, with the offset on, a 102 GB download came out with one bit changed and btrfs reported no
  error, so the bit changed in memory or in the CPU before it reached the disk. Not traced: a day of the checks
  above, with and without the offset, would show whether the offset is to blame.
- Set with [RyzenAdj](https://github.com/FlyGoat/RyzenAdj) 0.18.0 from
  [COPR shdwchn10/ryzenadj](https://copr.fedorainfracloud.org/coprs/shdwchn10/ryzenadj/):
  `sudo ryzenadj --set-coall=1048526`, which is 1048576 minus the offset and lasts until a reboot. The package
  builds a kernel driver, `ryzen_smu`, in the minute after its install; the command works with and without it.
- Every chip is different. Check the arithmetic on all cores and on each core alone
  (`stress-ng --cpu-method matrixprod --verify`), and run the full-load test (`llm-server/acceptance.py`) with
  the offset on before installing the unit. After a freeze or a failed check, a reboot clears the offset
  unless the unit is enabled.

## Memory

The LLM server's 128 GiB with the model loaded and four 256K sessions, idle after the tests under [Load](#load)
(`/proc/meminfo` and the GPU's `mem_info_gtt_used`):

| Use | GiB | Share |
|---|---|---|
| Model, MTP, vision and 4 sessions on the GPU | 111.5 | 87% |
| Prompt cache (3.6 of its 4 GiB in use), Gufo and Linux | about 7 | 5% |
| Free | 6.6 | 5% |
| Never available to programs | 3.1 | 2% |

The last row, from the boot log: 2.0 GiB is the kernel's record of every 4 KiB page (64 bytes each), 0.5 GiB the
GPU's fixed memory, 0.35 GiB firmware and 0.23 GiB the kernel itself. The portal server's 8 GiB lose 0.37 GiB the
same way (0.12 page records, 0.11 firmware with 32 MiB for graphics, 0.14 kernel) and show as 7.6 GiB.

| Layout | Free memory | Timings |
|---|---|---|
| 4 × 256K | 9.6 GiB after load. Lowest: 5.7-7.0 GiB with four full prompts at once (six runs), 4.7 GiB while four raw 12 MP photos were read | See [Load](#load) |
| 4 × 225K | 12.7 GiB after load. Lowest: 9.1 GiB with four full prompts at once | See [Load](#load) |
| 7 × 128K | 11.7 GiB after load, about 6 GiB while in use. Lowest: 5.7 GiB with seven full prompts at once on Gufo 0.34.0 (8.8 GiB on 0.35.0, right after a restart), 4.0 GiB while a raw 12 MP photo was read | See [Load](#load) |
| 3 × 256K | About 12 GiB under full load, with an idle workspace stack next to the model | Three 259,000-token prompts at once: first words after 8 minutes, follow-up turns after 0.7 seconds |

Agents on the LLM server itself, four sandboxes of 3 GB each next to the model. The 3 × 256K layout was not
tried with busy sandboxes.

| Layout | Lowest free memory |
|---|---|
| 7 × 128K | 1.2 GiB |
| 6 × 128K | 1.1 GiB |
| 5 × 128K | 3.0 GiB (0.6 GiB in a second run) |
| 4 × 128K | 4.1 GiB |

## Load

Four 256,000-token prompts at once (`llm-server/acceptance.py`), one run on November 18, 2026, Gufo 0.35.0:

- All four sessions wrote their first word after 629 to 634 seconds, and every tool call was correct.
- The follow-up turns answered in 0.7 to 1.1 seconds.
- Nothing was written to swap, nothing was killed for lack of memory, and free memory stayed above 7.0 GiB.
- The chip reached 100 °C.

The same sessions with images, right after it. The photo is a generated JPEG of 4,000 × 3,000 pixels, sent
straight to the API, 11,800 tokens to the model:

- Three 256,000-token prompts and the photo in the fourth session: first words after 507 to 519 seconds, the
  photo answered after 69 seconds, free memory above 4.8 GiB.
- Four such photos at once: answered after 37 to 38 seconds, free memory above 4.7 GiB.
- Four pictures of 1,568 pixels, the size Qwen Code sends: 5 to 6 seconds, and free memory did not move.
- In all of it nothing was written to swap, no request failed and the model never restarted.

Five more runs on November 20 and 21, 2026, with three [n-gram tables](#n-gram-table): first words after 632 to
639 seconds with the 4.5-bit table (two runs), 636 to 641 with the 8.5-bit one (one run) and 640 to 649 with the
full-precision one (two runs), every tool call correct. Free memory stayed above 5.7 GiB. Four runs moved 0 to 9
pages to swap; one, with the 4.5-bit table, moved 6,400, which the test reports as `CAPACITY FAIL`.

Four 225,000-token prompts at once, one run on November 18, 2026 with four sessions of 230,400 tokens:

- All four sessions wrote their first word after 546 to 554 seconds, and every tool call was correct.
- The follow-up turns answered in 0.7 to 1.0 seconds.
- Nothing was written to swap, nothing was killed for lack of memory, and free memory stayed above 9.1 GiB.
- The chip reached 99 °C.

Seven 128,000-token prompts at once (`--users 7 --target 128000`), two runs the same day:

- All seven sessions wrote their first word after 523 to 532 seconds, and every tool call was correct.
- The follow-up turns answered in 0.4 to 1.8 seconds, because the 128,000 tokens were already cached.
- Nothing was written to swap, nothing was killed for lack of memory, and free memory stayed above 8.8 GiB.
- For the first three minutes the chip ran at its limit, 98 °C on the CPU's sensor and up to 101 °C on the
  GPU's, with the fans at 95%. Then it held 88-89 °C.

A full machine, the worst case that was tried: seven clients each sent a 122,000-token prompt, eight more
requests queued behind them, a second wave of seven followed, and real agents worked at the same time.

- A new long prompt waited 9-17 minutes for its first word.
- Nothing failed, the model never restarted, and free memory stayed above 6.3 GiB.
- Once that load ended, agent turns started after 0.6 seconds (median of 278 agent requests) and wrote at
  53 tok/s: Gufo keeps each conversation and reads only what is new, about 540 tokens per turn in prompts of
  56,000 (median).

Images:

- Qwen Code shrinks images to 1,568 pixels on the long edge. A raw photo sent straight to the API on an idle
  server was answered after 147 seconds (12 MP) and 353 seconds (16.8 MP).
- Sent while another agent was writing, the 12 MP photo pulled free memory down to 4.0 GiB for a moment and
  still completed.
- A full-size 12 MP photo takes about 2.5 minutes to encode. With `--stall-timeout-ms` at 120 seconds that
  restarted the model, hence the 10 minutes in `llm-server/gufo.container`.

Engine update through Admin > Updates, November 17, 2026:

- 0.34.0 to 0.35.0 in 51 seconds, 15 of them for the 3.4 GiB download, and back in 31.
- A workspace that sent a request every second lost none; the two that arrived during a restart waited
  32 seconds.
- The day before, a forced bad update put 0.31.0 back by itself.

After a reboot, November 18, 2026: Gufo answers after 32 seconds and the portal, over HTTPS, after 22, counted
from the start of the kernel. A restart of Gufo alone is healthy after 17 to 18 seconds.

## Replies and thinking

On Gufo a reply's `max_tokens` includes its thinking, and the effort level is an instruction to the model, not
a limit. November 18, 2026, Gufo 0.35.0, Qwen Code 0.28.0:

- With seven 128K sessions, Qwen Code's context at 131,072 and `max_tokens` at 32,768, three turns of one agent
  session ended without an answer. Their prompts were 88,000 to 93,000 tokens, Qwen Code had shrunk the replies
  to 26,000-26,700 tokens to fit the context, and the model spent all of them thinking, 7 minutes each. With
  `max_tokens` in its settings Qwen Code does not continue a reply that was cut off.
- The same kind of task, a 93,700-token document to summarize, with four 225K sessions, 64,000-token replies
  and `--reasoning-budget 32000`, both efforts at once:

| Effort | Thinking | Answer | Time |
|---|--:|--:|--:|
| `xhigh` | 26,349 tokens | 25,999 tokens, complete | 17.7 min |
| `low` | 387 tokens | 7,490 tokens, complete | 5.0 min |

- `--reasoning-budget` ends the thinking after that many tokens. Neither run reached it.
- Qwen Code asks for 64,000 tokens for a qwen3 model when its settings name no `max_tokens`: every request of a
  session in a portal workspace carried it. It asks for less when the context has less left after a 5% margin:
  with its own compaction point, 85% of the context, 26,000 tokens in a 262,144-token session; with
  `autoCompactThreshold` 0.7 (`models/system-defaults.json`) it compacts at 183,500 tokens, where 64,000
  still fit. The last two numbers come from running Qwen Code's own functions, not from a session that long.
- That session, at `low`: the agent read the same document with its file tool and answered a 110,500-token
  prompt with 33,300 tokens, three quarters of them thinking, in 13.8 minutes. The old settings left such a
  reply 10,500 tokens.
- With four 256K sessions, in a portal workspace at `low`, twice: the agent read a 152,600-token document with
  its file tool, in prompts that grew to 175,800 and 166,500 tokens and asked for 64,000 each. It answered a
  168,600-token prompt with 21,600 tokens in 6.5 minutes and a 162,100-token prompt with 18,000 in 5.2. The
  first answer came in Chinese, to an English document and request, and ended at a heading mark; the second
  was English and complete. With sessions of 230,400 tokens Qwen Code compacts such a conversation at 154,000.
- A reply cut off at its limit (forced, 3,000 tokens): Qwen Code asked the model to resume, and the model picked
  up mid-word in 7 of 8 tries; in one it wrote a single letter and stopped.
- Qwen Code ends a reply's stream after an hour (`QWEN_STREAM_MAX_LIFETIME_MS` in the workspace image; 15 minutes
  without it, and 0.28.0 does not read `streamMaxLifetimeMs` from a model's entry), then asks the model to
  resume, which it did. A 64,000-token reply stays under the hour at 18 tokens a second; with three sessions
  writing, two long replies got 30 and 34.

## Model and engine

Nine setups ran the same ten coding tasks, three agents at a time, each task checked by an independent grader
with a 30-minute limit. Each row ran once, with short starting prompts: it shows which setup gets agent work
done on this hardware, not a ranking of the models.

| Model and engine | Finished | Correct files | Median task |
|---|--:|--:|--:|
| **Qwen3.8-Flash-Next Q4 · Gufo 0.31, MTP** | **7 / 10** | **9 / 10** | **8:25** |
| Flash-Next Q5 · llama.cpp fork, no MTP | 7 / 10 | 9 / 10 | 21:21 |
| Flash-Next Q6 · llama.cpp, no MTP | 7 / 10 | 9 / 10 | 22:51 |
| Flash-Next GSQ IQ3 · llama.cpp, no MTP | 7 / 10 | 7 / 10 | 9:26 |
| MiMo V2.6 Flash, mixed IQ2 · llama.cpp | 7 / 10 | 7 / 10 | 18:31 |
| DeepSeek V4.1 Flash IQ1_M · llama.cpp | 6 / 10 | 8 / 10 | 19:25 |
| Qwen3.8-27B Q8 · Gufo, no draft model | 3 / 10 | 4 / 10 | 30:02 |
| GLM-5.3-Flash EXL3 · Kyojin | 0 of 4 | 1 of 4 | stopped early |
| MiniMax M3.1 Flash · Maya-XS FP4 | 0 of 3 | 1 of 3 | stopped early |

Flash-Next Q4 on Gufo ties for the best score and needs well under half the time of the others that tie.
Gufo 0.30 scored the same as 0.31, with a median of 8:22.

### Bigger quantizations

- Q5 (158 GB) and Q6 (169 GB) are larger than the RAM, so part of the file is read from the SSD while the
  model runs. They scored the same as Q4 and took about 2.5 times as long.
- Q5 writes 23 tok/s for one user, and four 128K sessions of it filled the RAM and fell to 0.5 tok/s each.
- Against Q5 on the same text, Q4's perplexity is 0.35% worse (3.831 against 3.818) and it picks the same next
  word 94.1% of the time. The Q5 files also hold the n-gram table at 8.5 bits instead of 4.5: see
  [N-gram table](#n-gram-table).
- Q4 is the largest Flash-Next file that Gufo loads.

### N-gram table

Flash-Next has a table of 51.2 billion values that Gufo reads from the SSD a few rows at a time, while the rest
of the model stays in memory. Unsloth's Q4 files bring it at 4.5 bits a value (IQ4_NL, 28.8 GB), in the
revision the guide uses as a file of its own. The repository has the table to put in that file's place at 8.5
bits (Q8_0, 54.4 GB) and at full precision (BF16, 102.4 GB). On 3,000 random rows an IQ4_NL row is off its BF16
row by 7.6% and a Q8_0 row by 0.5%, as Unsloth lists.

The same Q4 model with only the table swapped, November 20 and 21, 2026.

**What the model predicts.** llama.cpp b12464 scored 102,400 tokens of each text in chunks of 2,048, and 98,304
in chunks of 32,768, and compared every prediction with the BF16 table's. The control is the BF16 table once
more with the prompt computed in batches of 256 tokens instead of 512: the same arithmetic in another order.

| Text | Table | Perplexity against BF16 | Same top token as BF16 | KL divergence from BF16 |
|---|---|--:|--:|--:|
| wikitext-2 test | IQ4_NL | **+0.30%** | 95.12% | 0.0184 |
| | Q8_0 | +0.03% | 96.17% | 0.0112 |
| | control | +0.00% | 96.10% | 0.0112 |
| This repository's source | IQ4_NL | -0.07% | 95.39% | 0.0255 |
| | Q8_0 | +0.10% | 95.80% | 0.0208 |
| | control | +0.02% | 95.77% | 0.0207 |
| The same in 32,768-token chunks | IQ4_NL | +0.11% | 96.23% | 0.0196 |
| | Q8_0 | +0.11% | 96.63% | 0.0159 |
| | control | +0.12% | 96.60% | 0.0159 |

- The perplexity differences have a standard error of 0.06 to 0.09 points.
- The control is as far from BF16 as Q8_0 is. Reordering the arithmetic alone changes the top token at 3.4 to
  4.2% of the positions, while a second run with nothing changed reproduces 99.999%. Only what exceeds the
  control is the table's doing, and Q8_0 exceeds it nowhere.
- IQ4_NL changes the top token at 1.0 point more positions than the control on wikitext and 0.4 on the code, 10
  and 6 standard errors. On wikitext its perplexity is 0.30% worse, 3.3 standard errors; on the code it is the
  same.
- IQ4_NL against Q8_0 directly: its perplexity is 0.27% worse on wikitext (2.9 standard errors), 0.17% better
  on the code in chunks of 2,048 (2.0) and the same in chunks of 32,768.
- Against the Q5 model with the BF16 table, on the code, the Q4 model's KL divergence is 0.0464 with IQ4_NL,
  0.0443 with BF16 and 0.0441 with Q8_0. Q5's own perplexity there is within 0.1% of Q4's.
- llama.cpp swaps the table with `--ple FILE`. With the BF16 table it also needs `-lm mmap`: without it the
  table is loaded into RAM, 95 GiB next to the model, and the run is killed for memory.

**Answers**, through Gufo 0.35.0, greedy:

- 76 LiveCodeBench problems from December 2024 to April 2025, 60 medium and 16 hard, four at a time, thinking
  ended after 3,000 tokens, each answer run against the problem's tests: 52 solved with IQ4_NL, 52 with BF16 and
  54 with Q8_0. Between any two tables 16 to 22 problems were solved with one and not with the other, split 11
  to 11, 9 to 11 and 7 to 9: chance. The thinking took 159,348 tokens with IQ4_NL, 159,411 with BF16 and 155,855
  with Q8_0.
- `gufo eval`, 75 questions: 56 right with IQ4_NL, 53 with BF16. They disagree on 7 questions, 5 to 2, and
  four of the five were BF16 answers cut off at the 16,000-token limit while still thinking. That is chance
  (sign test p = 0.45). Not run with Q8_0.
- Next word at 3,681 positions of wikitext-2: the right one at 63.7% with IQ4_NL, 63.3% with BF16 and 63.6% with
  Q8_0. No two differ by more than 0.4 points, and each 95% interval spans zero: too few positions to show a
  difference of the size above.
- At those positions Q8_0 has BF16's top token 96.9% of the time and IQ4_NL 94.9%, 5.8 standard errors apart.
  A second run with IQ4_NL reproduced every prediction of the first. So did, at 300 positions, the revision the
  guide uses, where that table is the fourth file: the other IQ4_NL runs used an older revision that has it
  inside the second.

**Speed**, Gufo 0.35.0, each run after a restart and with the page cache dropped: three runs with IQ4_NL, two
with each of the others.

| | IQ4_NL | Q8_0 | BF16 |
|---|--:|--:|--:|
| Reading a 2K prompt, tok/s | 1,627-1,846 | 1,729-1,772 | 1,598-1,736 |
| Reading an 8K prompt | 1,826-1,920 | 1,857-1,918 | 1,823-1,863 |
| Reading a 32K prompt | 1,819-1,861 | 1,847-1,854 | 1,788-1,832 |
| Reading a 64K prompt | 1,755-1,804 | 1,754-1,824 | 1,753-1,762 |
| Reading a 128K prompt | 1,714-1,721 | 1,717 and 1,720 | 1,711 and 1,719 |
| Writing, five 1,000-token answers | 49.9 in each run | 50.2 and 50.2 | 50.2 and 50.2 |
| Writing after a 64K prompt, the same four prompts for all | 50.8 and 51.8 | 51.5 and 52.7 | 51.2 |
| The guide's speed check, sampled answers | 54.5-73.0, median 64.3 (40 answers) | 52.0-69.0, median 64.9 (20) | 51.4-78.9, median 65.7 (39) |
| Four users at once, writing, each | 18-33 | 18-33 | 19-31 |
| Four users at once, reading, each | 1,541-1,938 | 1,655-1,922 | 1,529-1,843 |
| GPU memory in use | 110.8-111.5 GiB | 110.8-111.6 GiB | 110.8-111.5 GiB |
| Read from the SSD per token of a prompt of 32K or more | 27-38 KB | 30-43 KB | 42-46 KB |
| Four 256,000-token prompts, first words | 632-639 s, two runs | 636-641 s, one run | 640-649 s, two runs |
| Model load, as Gufo logs it | 16.4-19.3 s | 15.8-17.0 s | 16.3-17.6 s |

- `/models` on the test machine is on btrfs, which Fedora mounts with `compress=zstd:1`. The BF16 values
  compress, and every row read then unpacks a whole compressed extent: 264-283 KB from the SSD per prompt
  token, and prompts read 10-16% slower. The numbers above are from uncompressed tables: `chattr +m` on the
  folder before the download keeps btrfs from compressing what lands in it. The guide's `/models` is XFS, which
  does not compress.
- Q8_0 is in use since November 20, 2026. Over the 4.5-bit table it costs 26 GB of SSD, no memory and no speed
  that these runs show. What it buys is small: 0.3% on wikitext, predictions as close to the full-precision
  table's as a reordering of the arithmetic leaves them, and nothing that the code or the answers show. BF16
  measured the same as Q8_0 and takes 48 GB more.

### Gufo and llama.cpp

Each engine's own benchmark tool, one session, Gufo 0.28.1. Gufo reads prompts three to four times as fast.

| Engine, same Q4 file | Reading, tok/s | Writing, tok/s |
|---|--:|--:|
| **Gufo** with MTP | **1,862** (1,653 at 32K) | **61.4** |
| Gufo without MTP | 1,899 (1,717 at 32K) | 29.6 |
| llama.cpp, ROCm | 656 (424 at 32K) | 24.1 |
| llama.cpp, Vulkan | 615 (372 at 32K) | 27.2 |

### Halogen and Strata

Three clients at once, each with its own prompt of about 8,000 tokens and a 1,024-token answer. The rate is
all output in tok/s over the whole request, prompt reading included. Cold is a new prompt, warm the same
prompt again.

| Engine, same Q4 file | Three clients, cold / warm | Lowest free memory |
|---|--:|--:|
| **Gufo 0.30** with MTP | **48.4 / 61.3** | 13.7 GiB |
| Gufo 0.30 without MTP | 44.1 / 57.0 | 18.5 GiB |
| Halogen | 46.5 / 46.8 | 8.2 GiB |
| Halogen, prompt cache on | 46.0 / 62.0 | 6.3 GiB |
| Strata 0.2.10 | 30.5 / 52.7 | 20.4 GiB |

- The Gufo row with MTP is the median of three runs; the others ran once. Strata's first start failed; the row
  is its second run.
- With a single client: Gufo 34.2 / 39.8, Halogen 33.5 / 33.7, Strata 25.5 / 39.3.
- Halogen is as fast as Gufo here but leaves 6-8 GiB free where Gufo leaves 14, and it is closed source.
- Neither Halogen nor Strata ran the coding tasks or a full-context test.
- Other model files in the same test, three clients: Flash-Next Q5 on the llama.cpp fork 30.8 / 47.2,
  Flash-Next GSQ IQ3 33.5 / 55.4, MiMo V2.6 Flash 22.1 / 37.0.

### Full contexts

Three sessions, three different prompts that nearly fill the context, sent at once. Each had to find a key far
back in the text, make a tool call and answer the tool's result. Times are minutes:seconds to the first reply.

| Setup | Layout | First replies | Result |
|---|---|--:|---|
| **Flash-Next Q4 · Gufo 0.31** | 3 × 256K | **7:59-8:01** | Passed. A second run touched swap for a moment (10 pages). |
| Flash-Next Q4 · Gufo 0.30 | 3 × 256K | 8:31-8:32 | Correct, with 73 MiB written to swap. |
| Flash-Next Q5 · llama.cpp fork | 3 × 128K | 3:27-10:07 | Passed. |
| Flash-Next Q5 · llama.cpp fork | 3 × 256K | 7:10-21:51 | Correct, but swapping all the way. |
| Flash-Next Q6 · llama.cpp | 3 × 128K | 3:44-10:57 | Passed. |
| Flash-Next GSQ IQ3 · llama.cpp | 3 × 256K | 4:02-12:19 | Passed. |
| MiMo V2.6 Flash · llama.cpp | 3 × 128K, 3 × 256K | none | Failed both: no correct tool call. |
| GLM-5.3-Flash EXL3 · Kyojin | 3 × 128K | 3:03-9:49 | Correct. Reads the prompts one after another. |
| MiniMax M3.1 Flash · Maya-XS FP4 | 3 × 128K | 29:11-86:55 | Correct. Reads the prompts one after another. |
| Ling 3.1 Flash EXL3 · TabbyAPI | 3 × 128K | 97:45-100:47 | Correct, but swapping all the way. |
| DeepSeek V4.1 Flash · llama.cpp | 3 × 128K | none | Stopped by hand before it finished. No result. |

Coding with a long history, on Gufo 0.31: three sessions each started with 128,000 tokens of history and then
got a task. Two passed, in 12:33 and 14:09. The third spent its whole 24,576-token reply thinking and failed.

### Qwen3.8-27B

A third of the size, but slower here.

| | One user | Each of four |
|---|--:|--:|
| Qwen3.8-27B Q8 | 17 tok/s | 8.7 tok/s |
| Qwen3.8-27B Q4 with the DFlash2 draft model | 27 tok/s | 10 tok/s |
| Flash-Next, same test | 50 tok/s | 20.5 tok/s |

- A harder set with four agents at once: 12 of 20 tasks passed, where Flash-Next passed 18. Half of its
  failures used up the thinking budget before a single file was written; most of the rest ran out of time.
- An easier set of nine tasks run three times each: the 27B passed 26 of 27. Flash-Next passed 27 of 27 once
  one task, which had failed its first three attempts, was run again.

Tried once more on November 9 at Q8 with newer engines:

- Gufo with DFlash2: 20 tok/s for one user and about 6 each with six. Six prompts of 165,000 tokens at once
  waited 54-57 minutes for the first word and then wrote 2.8 tok/s each; one 250,000-token prompt took
  16 minutes to read. Gufo's MTP does not load the 27B files.
- llama.cpp is the only engine that fits six 256K sessions of it, at 11 tok/s for one user and 6 each with six.
- Halogen wrote 17 tok/s for one user and served six requests one after another.

## Portal server

### Workspace memory

Qwen Code's process grows to about 1.9 GB on its first tool call and then falls back to about 300 MB. The 8 GB
machine has about 6.3 GB free with the portal and search running.

| Workspaces and limit | Result |
|---|---|
| 1.25 GiB each | Every agent was killed. |
| 2 GiB each, four agents | Ran for 21 minutes without a kill. |
| Two at 2.25 GiB plus 512 MiB of swap each | About 1 GB left with both filled to the limit. |
| Three at 2 GiB | A realistic run finished with 2.8 GB to spare. In the pinned worst case free memory fell to 13 MB and the kernel killed a workspace process. |
| Three at 2.25 GiB | In use since November 18, 2026. Not measured with Qwen Code: its worst case is that of the row above. |

With more RAM, count about 2.75 GiB per workspace.

OpenCode 2.4.1 in three workspaces of 2.25 GiB, during the 51 turns under [OpenCode](#opencode):

- A workspace that has just started holds about 300 MiB. OpenCode's own process has 150 MiB then and 290 to
  395 MiB while it works (434 at most), the same with 20,000 tokens of conversation as with 208,000.
- Without the file cache, a working workspace held at most 364 to 915 MiB, depending on the work. The 915 MiB
  were the one whose agent opened its page in the workspace's Chromium (883 MiB) and ran a Go test under the
  race detector (567 MiB). g++ took 408 MiB, the Go compiler 170 and rustc 147.
- With the file cache, that same workspace peaked at 2,297 MiB, 7 below its limit; 1,224 MiB of it were file
  cache at its end. The kernel counted no hit of the limit and killed nothing. The six other runs of a
  workspace peaked at 398 to 857 MiB.
- The machine kept at least 4,306 MiB available while three workspaces worked, and 4,056 MiB while two worked
  and the one with Chromium was among them. Swap use did not change.

### OpenCode

OpenCode 2.4.1, November 24, 2026, Gufo 0.36.0: 51 turns in six conversations in Private workspaces, sent
through OpenCode's own API inside each workspace, with its page closed. The tasks were small projects in Go,
C++, Rust, Python, Bash and PowerShell, each built and tested by the agent.

- The gateway passed 500 model requests and none failed. 50 turns succeeded; the one that failed was made to
  (the cut-off below). No turn waited for an approval or a question.
- Of 473 tool calls, 6 edits failed because their old text was not in the file, and the agent repeated each.
  2 more were the cut-off's.

One long conversation, alone:

- 21 turns. After the fourth the workspace was left alone and stopped for idleness. Started again 40 minutes
  after that turn, the conversation went on with its 61,320 tokens.
- Reads of 2,000 lines of Go's own source added up to 26,000 tokens each, until the conversation had 207,733.
  On the next turn OpenCode shortened it by itself, to 20,345 tokens; that turn took 44 seconds. This fits a
  limit of the window less the reply limit (262,144 − 64,000 = 198,144 tokens), which is an estimate:
  OpenCode's rule was not looked up.
- Afterwards the agent still named two facts from the first turn that were in no file, and worked on for 8
  turns. The tests of both projects passed at the end.
- The first word came after 0.2 to 5 seconds when only the prompt was new, after 15 to 17 seconds behind 25,000
  new tokens, and after 28 seconds when 72,745 tokens were read again after the restart. The gateway counted
  1,594 tok/s reading.

Three workspaces at once:

- Three conversations worked at the same time for 13 minutes and two for 17 more. Every turn succeeded.
- A turn took 3.5 seconds to 11.4 minutes. The longest was the first after a restart, with 79,689 tokens to
  read again and 62 seconds to the first word.
- Writing, per conversation, as the gateway counted it: 61 to 65 tok/s alone, 48 with two at once, 37 to 45
  with three.
- One agent had a subagent review its code in the background and looked at its own page with the browser
  tools; the review came back two turns later.
- A workspace used 0.03 to 0.10 of a core on average: most of a turn is the model's time.
- The LLM server did not restart and no session waited for memory (`gufo_shared_state_waits_total` stayed 0).

A reply cut off at its limit. Asked for 30,000 lines of numbers, the model declined and gave a command
instead, so the cut-off was forced: one workspace got a reply limit of 1,500 tokens.

- A plain answer: OpenCode tells the model that its answer hit the limit and lets it go on, twice. The third
  cut-off ends the turn as failed (`Response still truncated after two output token limit continuations`). The
  three parts stay in the conversation, and "continue" as the next prompt finished the text.
- A tool call cut off inside its arguments is not run, and the model is told to send smaller pieces. Asked for
  a file of 2,000 lines in one call, it was cut off twice and then wrote the file in 20 pieces. The file was
  complete after 219 seconds.

### Web search

- 30 searches, one every 20 seconds: none came back empty and each took a second or less.
- About one query a second got the test address blocked by Brave and DuckDuckGo for over an hour.
- Keenable returns a passage of each page instead of a one-line snippet and allows 1,000 searches an hour from
  one address without a key, but it has no page 2 and no date filter. Yahoo and Yandex have both and
  MetaCrawler has page 2.

| Engine left out | Why |
|---|---|
| `google` | Answers 403. |
| `startpage` | Answers a CAPTCHA. |
| `bing` | Searches only the first word. |
| `brave` | Answers "too many requests" after about ten searches. |
| `wikipedia` | Needs a contact address in this SearXNG version. |
| `google cse` | Needs a Google key. |

### Page reader

- 29 public pages on the 2-core machine: 26 were read in 0.2 to 3.8 seconds each. Stack Overflow, npm and
  Reddit could not be read.
- Tested with one agent of each kind and with six pages at a time.

### portal-hostd

- While someone has Admin > Usage open: about 1 ms of CPU per reading, 0.2% of one core and 25 MB of RAM.
- The rest of the time it adds up energy and traffic, one read every 2 seconds: under 0.05% of one core.
- The per-session speeds come from Gufo's `/slots` and the answers the portal already passes on, so the model
  does no extra work.

### Portal pages

Every page in Chrome with touch emulation at 320 to 1,920 pixels wide: nothing scrolls sideways and every
button is at least 40 pixels under a finger. Not tried on a real phone or with a screen reader.
