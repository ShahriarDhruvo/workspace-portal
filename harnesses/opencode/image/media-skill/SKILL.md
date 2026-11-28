---
name: media-production
description: Use before making a video, a song, a narration, a podcast or any piece that combines generated images, video clips, speech and music with generate_image, generate_video, generate_music, synthesize_speech and transcribe_audio. Plans the piece with the person, picks a fast or quality tier for each part, batches the work by model, checks every part and assembles the result with ffmpeg.
---

# Making a media piece

The media models share one GPU with the LLM you run on. The everyday speech and transcription models run beside you;
every other model is loaded alone, and changing model takes from half a minute to a few minutes. While a video or a
long track is being made nobody's LLM requests are answered, yours included. So plan everything first, make all the
parts of one kind together, and check each part before the next phase depends on it.

Each kind has two tiers (your instructions list them, and `list_media_models` says which are loaded now). A kind with
one model, as your instructions say, uses it for both:

- **fast**: drafts, tries, storyboards, keyframes to test, checking speech. Minutes instead of tens of minutes.
- **quality**: the final version of a part, once the person has seen and approved its draft, or when they ask for the
  final or the best from the start.

## 1. Plan, and get a go-ahead

Call `list_media_models`. Then write `media/<piece>/plan.md` before making anything:

- the piece in two sentences, its total length, its aspect ratio (512x512 square, or 1344x768 wide);
- a shot list: for each shot its number, length (5 to 14 s), what is seen (subject, action, camera, light, style),
  the sounds of the scene, the narration or dialogue said over it (word for word), and its keyframe;
- the music: style, tempo, where it starts and stops, instrumental under speech;
- the file each part goes to: `media/<piece>/keyframes/shot-01.png`, `clips/shot-01.mp4`, `speech/shot-01.wav`,
  `music/theme.wav`, `final.mp4`.

Then show the person the plan as a table and wait for their answer:

| Step | Asset | Tier & model | Why | Est. time |
|---|---|---|---|---|
| 1 | 4 keyframes | quality, Ming-Image 0.2 Design | the frames the clips start on | about 2.5 min |
| 2 | 4 clips, 5 s each | fast, MiniMax H3 fast preset | try the motion | about 15 min, the server busy |

Take the times from your instructions, add a model swap where the model changes, and add up the total. End with:
Reply **go** to start, or tell me what to change. Make nothing before they answer. For a piece that matters, plan two
passes: every part in the fast tier first, shown to the person, then again in the quality tier for what they approve
(a draft's `seed` comes back in its answer: pass it again to keep a voice or a composition).

## 2. Make the parts, one model at a time

Do the phases in this order, and finish one before starting the next. Never alternate between tools. Within a phase,
call the tool for all its parts in one message: the calls run one after another on the model, which is loaded once. A
call a message loads you again after every part, and then the model again.

1. **Keyframes** (generate_image, from one `execute` script: `await Promise.all(shots.map((shot) =>
   tools.generate_image({ prompt: shot.prompt, path: shot.path })))`). One image per shot, at the shot's aspect ratio
   (a new image is 1024x1024 unless `model` names a size: for 1344x768 shots add
   `model: "<image model>#1344x768"`, with a model your instructions list that size for), all with one image model:
   the quality model, or the fast one when there are many frames to try. Look at every image with your `read` tool
   (it shows you a picture when the model you run on takes images) and check it against its shot: subject,
   composition, style, that faces and hands are right, that there is no stray text. Make again (another prompt)
   what does not match. The frames the person approves are the keyframes: the other image model
   would make another picture, not a better copy. To change part of a frame (a colour, an object, a word), give the
   frame to generate_image as `images` with what to change; do the changes together, after the new frames, because
   they may run on another model.
2. **Speech** (synthesize_speech). One call per line and speaker. Give each speaker one voice for the whole piece: the
   same built-in `voice`, the same `voice_description` and `seed`, or the same `reference_audio`. A tier may take
   only some of these; the tool's description says which. Where a tier takes only `reference_audio`, the model
   picks the voice of a line that has none: for a speaker who must sound the same in every line, first make a short
   sample of the voice (5 to 10 s, in the tier with built-in or described voices) and give it to every line as
   `reference_audio`, with its words as `reference_text`. The fast tier runs beside you and stops nothing; use the
   quality tier for the final narration when the person wants the most natural delivery, with a tag such as
   `[whisper]` or `[laughing]` before the words it applies to.
3. **Check the speech** (transcribe_audio, fast tier). Transcribe every line and compare it with the script; make again
   any line with a missing, added or wrong word. Then measure each file:
   `ffprobe -v error -show_entries format=duration -of csv=p=0 media/<piece>/speech/shot-01.wav`.
   A shot must be at least as long as its line plus half a second: lengthen the shot in the plan where it is not.
4. **Music** (generate_music). One track as long as the whole piece plus two seconds (sum the shot lengths). Try the
   style in the fast tier at 30 seconds first, then make the track in the quality tier.
5. **Clips** (generate_video). One call per shot, with the shot's keyframe as `first_frame` and the plan's length as
   `seconds`. Try a prompt you are unsure of in the fast tier; make the final clips in the quality tier, all of them
   one after another.
6. **Check the clips.** For each clip, extract its first, middle and last frame and look at them with `read`:
   `ffmpeg -v error -ss 0 -i clip.mp4 -frames:v 1 /tmp/shot-01-a.png` (and at the middle and one second before the
   end). Check that it starts on its keyframe, shows the action of the shot, and that nothing melts, flickers or
   jumps. Make again (new `seed`) what fails, at most twice, then tell the person what is still wrong.

## 3. Assemble

Clips from generate_video share their size, frame rate and codecs, so they join directly. Lay each shot's line over its
clip, keep the clips' own sound low, lower the music under the voice (sidechain ducking) and bring the whole mix to
-14 LUFS, the loudness of streaming platforms.

```sh
cd media/<piece>
# The clips in order.
printf "file '%s'\n" clips/shot-01.mp4 clips/shot-02.mp4 clips/shot-03.mp4 > clips.txt
# The narration track: each line padded to its shot's length (seconds from the plan), in order.
ffmpeg -v error -y -i speech/shot-01.wav -i speech/shot-02.wav -i speech/shot-03.wav -filter_complex \
  "[0:a]apad=whole_dur=8[a0];[1:a]apad=whole_dur=10[a1];[2:a]apad=whole_dur=6[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]" \
  -map "[out]" -ar 48000 -ac 2 narration.wav
# Total length, for the music's fade-out.
total=$(ffprobe -v error -f concat -safe 0 -i clips.txt -show_entries format=duration -of csv=p=0)
fade=$(awk "BEGIN { print $total - 2 }")
# Clips, their sound at 30%, the narration, and the music ducked under it; then loudness, H.264 and AAC.
ffmpeg -v error -y -f concat -safe 0 -i clips.txt -i narration.wav -i music/theme.wav -filter_complex \
  "[0:a]volume=0.3[sfx];[1:a]asplit=2[voice][key];\
   [2:a]volume=0.7,afade=t=out:st=$fade:d=2[music];\
   [music][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[ducked];\
   [sfx][ducked][voice]amix=inputs=3:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[mix]" \
  -map 0:v -map "[mix]" -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p \
  -c:a aac -b:a 192k -ar 48000 -movflags +faststart final.mp4
```

A shot without a line gets silence of its length (`-f lavfi -t 6 -i anullsrc=r=48000:cl=stereo`) in the narration
track. For music alone, drop the narration and the ducking; for a podcast or an audiobook, join the speech files with
`concat` and put the music only under the intro and outro.

Then check the result: `ffprobe` its duration against the plan, extract a frame from each shot, and transcribe the
final file to confirm every line is heard (transcribe_audio on `final.mp4`).

For subtitles, transcribe the final file to `media/<piece>/final.srt`, if the transcribe_audio tool offers .srt (a
model that writes times); otherwise tell the person this AI server makes none.

## 4. Report

Tell the person where `final.mp4` is, its length, which tier made each part, and which shots or lines were made again
or still fall short. Keep the parts: they can change one shot without making everything again.
