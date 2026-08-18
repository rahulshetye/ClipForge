from steps.captions import generate_captions
from steps.broll import suggest_broll_moments, fetch_broll_clips
from steps.assembly import assemble_video

video_path = "output/trimmed.mp4"
words = generate_captions(video_path)

moments = suggest_broll_moments(words)
print(f"Found {len(moments)} B-roll moments")

broll_clips = fetch_broll_clips(moments)
result = assemble_video(video_path, words, broll_clips=broll_clips)
print("Final video:", result)