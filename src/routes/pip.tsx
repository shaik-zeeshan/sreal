import { listen } from "@tauri-apps/api/event";
import { createSignal, onCleanup, onMount } from "solid-js";
import PipControls from "~/components/video/PipControls";
import { commands } from "~/lib/tauri";

export default function PipPage() {
  const [isPlaying, setIsPlaying] = createSignal(true);

  // biome-ignore lint/nursery/noMisusedPromises: we need to return a promise to listen to the event
  onMount(async () => {
    // Listen for playback state changes
    // const handlePlaybackState = (playing: boolean) => {
    //   setIsPlaying(playing);
    // };

    await commands.playbackPlay();

    // Set up event listeners for playback state
    // Note: In a real implementation, you'd want to listen to the same events
    // that the main video player listens to
    const pause = await listen("pause", (event) => {
      setIsPlaying(!(event.payload as boolean));
    });

    onCleanup(() => {
      pause();
    });
  });

  const handleTogglePlay = async () => {
    if (isPlaying()) {
      await commands.playbackPause();
      setIsPlaying(false);
    } else {
      await commands.playbackPlay();
      setIsPlaying(true);
    }
  };

  const handleClose = () => {
    commands.closePipWindow();
  };

  return (
    <div class="h-full w-full bg-transparent">
      <PipControls
        isPlaying={isPlaying()}
        onClose={handleClose}
        onTogglePlay={handleTogglePlay}
      />
    </div>
  );
}
