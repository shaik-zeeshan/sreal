import { Pause, Play, X } from "lucide-solid";
import { createSignal, onCleanup, onMount } from "solid-js";

type PipControlsProps = {
  isPlaying: boolean;
  onTogglePlay: () => Promise<void>;
  onClose: () => void;
};

export default function PipControls(props: PipControlsProps) {
  const [isVisible, setIsVisible] = createSignal(false);
  const [hideTimeout, setHideTimeout] = createSignal<NodeJS.Timeout | null>(
    null
  );

  const showControls = () => {
    setIsVisible(true);

    // Clear existing timeout
    if (hideTimeout()) {
      clearTimeout(hideTimeout() as NodeJS.Timeout);
    }

    // Set new timeout to hide controls
    const timeout = setTimeout(() => {
      setIsVisible(false);
    }, 3000);
    setHideTimeout(timeout);
  };

  const hideControls = () => {
    if (hideTimeout()) {
      clearTimeout(hideTimeout() as NodeJS.Timeout);
      setHideTimeout(null);
    }
    setIsVisible(false);
  };

  onMount(() => {
    // Show controls initially
    showControls();
  });

  onCleanup(() => {
    if (hideTimeout()) {
      clearTimeout(hideTimeout() as NodeJS.Timeout);
    }
  });

  return (
    <div
      class="absolute inset-0 flex h-full w-full items-center justify-center bg-black/20 backdrop-blur-sm transition-opacity duration-300"
      classList={{
        "opacity-0": !isVisible(),
        "opacity-100": isVisible(),
      }}
      onMouseEnter={showControls}
      onMouseLeave={hideControls}
      onMouseMove={showControls}
      role="button"
    >
      <div class="relative flex h-full w-full flex-col items-center justify-center">
        {/* Close button - top right */}
        <button
          class="absolute top-5 right-5 rounded-full bg-black/50 p-2 text-white transition-all hover:scale-110 hover:bg-black/70"
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
          title="Close Picture in Picture"
        >
          <X class="h-4 w-4" />
        </button>

        {/* Play/Pause button - center */}
        <button
          class="rounded-full bg-black/50 p-4 text-white transition-all hover:scale-110 hover:bg-black/70"
          onClick={(e) => {
            e.stopPropagation();
            props.onTogglePlay();
          }}
          title={props.isPlaying ? "Pause" : "Play"}
        >
          {props.isPlaying ? (
            <Pause class="h-6 w-6" />
          ) : (
            <Play class="h-6 w-6" />
          )}
        </button>
      </div>
    </div>
  );
}
