import { getAllWindows } from "@tauri-apps/api/window";
import {
  AudioLines,
  AudioWaveform,
  BookOpen,
  Captions,
  CaptionsOff,
  Gauge,
  Pause,
  PictureInPicture,
  Play,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-solid";
import { createMemo, For, Show } from "solid-js";
import type { Chapter, Track } from "~/components/video/types";
import { formatTime } from "~/components/video/utils";
import { commands } from "~/lib/tauri";
import { cn } from "~/lib/utils";

type VideoControlsProps = {
  state: {
    playing: boolean;
    currentTime: string;
    duration: number;
    volume: number;
    isMuted: boolean;
    audioIndex: number;
    subtitleIndex: number;
    playbackSpeed: number;
    audioList: Track[];
    subtitleList: Track[];
    chapters: Chapter[];
    // New buffering and loading states
    bufferedTime: number;
    bufferingPercentage: number;
    isLoading: boolean;
    isBuffering: boolean;
    isSeeking: boolean;
  };
  openPanel: () => "audio" | "subtitles" | "speed" | "chapters" | null;
  setOpenPanel: (
    panel: "audio" | "subtitles" | "speed" | "chapters" | null
  ) => void;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onVolumeChange: (value: number) => void;
  onProgressClick: (value: number) => void;
  onSetSpeed: (speed: number) => void;
  onNavigateToChapter: (chapter: Chapter) => void;
  onOpenPip: () => Promise<void>;
  audioBtnRef?: HTMLButtonElement;
  subsBtnRef?: HTMLButtonElement;
  speedBtnRef?: HTMLButtonElement;
};

export default function VideoControls(props: VideoControlsProps) {
  const progressPercentage = () =>
    (Number(props.state.currentTime) / props.state.duration) * 100 || 0;

  const bufferedPercentage = () => {
    if (props.state.duration === 0) {
      return 0;
    }
    return (props.state.bufferedTime / props.state.duration) * 100 || 0;
  };

  const getVolumeIcon = () => {
    if (props.state.isMuted || props.state.volume === 0) {
      return VolumeX;
    }
    if (props.state.volume > 50) {
      return Volume2;
    }
    return Volume1;
  };

  const currentAudioTrack = createMemo(() => {
    const track = props.state.audioList.find(
      (t) => t.id === props.state.audioIndex
    );
    if (!track) {
      return "Default";
    }
    return `${track.title || ""} ${track.lang || ""}`.trim() || "Default";
  });

  const currentSubtitleTrack = createMemo(() => {
    if (props.state.subtitleIndex === 0 || props.state.subtitleIndex === -1) {
      return "Off";
    }
    const track = props.state.subtitleList.find(
      (t) => t.id === props.state.subtitleIndex
    );
    if (!track) {
      return "Off";
    }
    return `${track.title || ""} ${track.lang || ""}`.trim() || "On";
  });

  const currentSpeed = createMemo(() => `${props.state.playbackSpeed}x`);

  return (
    <div class="rounded-xl border border-white/20 bg-black/90 p-4 shadow-2xl backdrop-blur-md">
      {/* Progress Bar */}
      <div class="mb-3 flex items-center gap-3">
        <span class="min-w-[50px] font-medium text-white text-xs sm:text-sm">
          {formatTime(Number(props.state.currentTime))}
        </span>
        <div class="relative flex-1">
          <div class="relative h-1.5 overflow-hidden rounded-lg bg-white/30">
            {/* Buffered range */}
            <div
              class="absolute top-0 left-0 h-full bg-white/40 transition-all duration-300"
              style={{ width: `${bufferedPercentage()}%` }}
            />
            {/* Current progress */}
            <div
              class="relative h-full bg-white/80 transition-all duration-150"
              style={{ width: `${progressPercentage()}%` }}
            />
            {/* Shimmer effect for buffered sections */}
            <Show when={props.state.isBuffering}>
              <div
                class="absolute top-0 h-full w-8 bg-gradient-to-r from-transparent via-white/20 to-transparent"
                style={{
                  left: `${bufferedPercentage()}%`,
                  animation: "shimmer 1.5s ease-in-out infinite",
                }}
              />
            </Show>

            {/* Enhanced buffering/seeking indicator */}
            <Show when={props.state.isBuffering || props.state.isSeeking}>
              <div
                class="-translate-y-1/2 absolute top-1/2 h-4 w-4 translate-x-1/2 rounded-full border-2 border-white bg-white/80 shadow-lg"
                style={{
                  left: `${props.state.isSeeking ? progressPercentage() : bufferedPercentage()}%`,
                  animation: props.state.isBuffering
                    ? "pulse 1.5s ease-in-out infinite"
                    : "none",
                  "box-shadow": props.state.isBuffering
                    ? "0 0 8px rgba(255, 255, 255, 0.6)"
                    : "none",
                }}
              />
            </Show>
            {/* Chapter markers */}
            <Show when={props.state.chapters.length > 0}>
              <For each={props.state.chapters}>
                {(chapter, index) => {
                  const chapterPosition = () => {
                    const startTimeSeconds =
                      chapter.startPositionTicks / 10_000_000;
                    return (startTimeSeconds / props.state.duration) * 100;
                  };

                  const chapterName = () =>
                    chapter.name || `Chapter ${index() + 1}`;
                  const chapterTime = () => {
                    const startTimeSeconds =
                      chapter.startPositionTicks / 10_000_000;
                    return formatTime(startTimeSeconds);
                  };

                  const isCurrentChapter = () => {
                    const currentTime = Number(props.state.currentTime || 0);
                    const chapterTime = chapter.startPositionTicks / 10_000_000;
                    const nextChapterTime = props.state.chapters[index() + 1]
                      ? props.state.chapters[index() + 1].startPositionTicks /
                        10_000_000
                      : props.state.duration;
                    return (
                      currentTime >= chapterTime &&
                      currentTime < nextChapterTime
                    );
                  };

                  return (
                    <div
                      class="group absolute top-0"
                      style={{ left: `${chapterPosition()}%` }}
                    >
                      {/* Chapter marker button */}
                      <button
                        class={cn(
                          "h-full w-2 cursor-pointer rounded-sm transition-all duration-200 hover:scale-y-110",
                          isCurrentChapter()
                            ? "bg-blue-400 hover:bg-blue-300"
                            : "bg-white/60 hover:bg-white/90"
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onNavigateToChapter(chapter);
                        }}
                      />

                      {/* Enhanced tooltip */}
                      <div class="-translate-x-1/2 pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 transform whitespace-nowrap rounded-lg bg-black/90 px-3 py-2 text-sm text-white opacity-0 shadow-lg transition-opacity duration-200 group-hover:opacity-100">
                        <div class="flex items-center gap-2">
                          <div class="font-medium">{chapterName()}</div>
                          <Show when={isCurrentChapter()}>
                            <div class="h-2 w-2 rounded-full bg-blue-400" />
                          </Show>
                        </div>
                        <div class="mt-1 text-white/70 text-xs">
                          {chapterTime()}
                        </div>
                        {/* Tooltip arrow */}
                        <div class="-translate-x-1/2 absolute top-full left-1/2 h-0 w-0 transform border-transparent border-t-4 border-t-black/90 border-r-4 border-l-4" />
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
          <input
            class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            max="100"
            min="0"
            onClick={(e) => e.stopPropagation()}
            onInput={(e) => {
              e.stopPropagation();
              props.onProgressClick(Number(e.currentTarget.value));
            }}
            type="range"
            value={progressPercentage()}
          />
        </div>
        <span class="min-w-[50px] text-right font-medium text-white text-xs sm:text-sm">
          {formatTime(props.state.duration)}
        </span>
      </div>

      {/* Controls */}
      <div class="flex flex-col gap-3 sm:gap-2 md:flex-row md:items-center md:justify-between">
        {/* Left Controls */}
        <div class="flex items-center gap-3 sm:gap-4">
          <button
            class="rounded-full p-2.5 text-white transition-all hover:scale-105"
            onClick={(e) => {
              e.stopPropagation();
              props.onTogglePlay();
            }}
          >
            <Show
              fallback={<Play class="h-6 w-6" />}
              when={props.state.playing}
            >
              <Pause class="h-6 w-6" />
            </Show>
          </button>

          <div class="flex items-center gap-x-2">
            <button
              class="rounded-full p-2 text-white transition-all"
              onClick={(e) => {
                e.stopPropagation();
                props.onToggleMute();
              }}
            >
              {(() => {
                const VolumeIcon = getVolumeIcon();
                return <VolumeIcon class="h-5 w-5" />;
              })()}
            </button>

            <div class="relative w-24 sm:w-32">
              <div class="h-1.5 overflow-hidden rounded-lg bg-white/30">
                <div
                  class="h-full bg-white/80 transition-all duration-150"
                  style={{ width: `${(props.state.volume / 200) * 100}%` }}
                />
              </div>
              <input
                class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                max="200"
                min="0"
                onClick={(e) => e.stopPropagation()}
                onInput={(e) => {
                  e.stopPropagation();
                  props.onVolumeChange(Number(e.currentTarget.value));
                }}
                type="range"
                value={props.state.volume}
              />
            </div>
          </div>
        </div>

        {/* Right Controls */}
        <div class="flex flex-wrap items-center justify-end gap-2">
          <Show when={props.state.audioList.length > 0}>
            <button
              aria-expanded={props.openPanel() === "audio"}
              aria-label={`Audio: ${currentAudioTrack()}`}
              class={cn(
                "rounded-full p-2 text-white transition-all",
                props.openPanel() === "audio" && "bg-white/20"
              )}
              onClick={(e) => {
                e.stopPropagation();
                props.setOpenPanel(
                  props.openPanel() === "audio" ? null : "audio"
                );
              }}
              ref={props.audioBtnRef}
            >
              <Show
                fallback={<AudioLines class="h-5 w-5" />}
                when={
                  props.state.audioIndex !== -1 && props.state.audioIndex !== 0
                }
              >
                <AudioWaveform class="h-5 w-5" />
              </Show>
            </button>
          </Show>

          <Show when={props.state.subtitleList.length > 0}>
            <button
              aria-expanded={props.openPanel() === "subtitles"}
              aria-label={`Subtitles: ${currentSubtitleTrack()}`}
              class={cn(
                "rounded-full p-2 text-white transition-all",
                props.openPanel() === "subtitles" && "bg-white/20"
              )}
              onClick={(e) => {
                e.stopPropagation();
                props.setOpenPanel(
                  props.openPanel() === "subtitles" ? null : "subtitles"
                );
              }}
              ref={props.subsBtnRef}
            >
              <Show
                fallback={<CaptionsOff class="h-5 w-5" />}
                when={props.state.subtitleIndex > 0}
              >
                <Captions class="h-5 w-5" />
              </Show>
            </button>
          </Show>

          <button
            aria-expanded={props.openPanel() === "speed"}
            aria-label={`Speed: ${currentSpeed()}`}
            class={cn(
              "rounded-full p-2 text-white transition-all",
              props.openPanel() === "speed" && "bg-white/20"
            )}
            onClick={(e) => {
              e.stopPropagation();
              props.setOpenPanel(
                props.openPanel() === "speed" ? null : "speed"
              );
            }}
            ref={props.speedBtnRef}
          >
            <Gauge class="h-5 w-5" />
          </button>

          <Show when={props.state.chapters.length > 0}>
            <button
              aria-expanded={props.openPanel() === "chapters"}
              aria-label="Chapters"
              class={cn(
                "rounded-full p-2 text-white transition-all",
                props.openPanel() === "chapters" && "bg-white/20"
              )}
              onClick={(e) => {
                e.stopPropagation();
                props.setOpenPanel(
                  props.openPanel() === "chapters" ? null : "chapters"
                );
              }}
            >
              <BookOpen class="h-5 w-5" />
            </button>
          </Show>

          <button
            aria-label="Picture in Picture"
            class="rounded-full p-2 text-white transition-all hover:bg-white/20"
            onClick={async (e) => {
              e.stopPropagation();
              const windows = await getAllWindows();
              const pipWindow = windows.find(
                (window) => window.label === "pip"
              );
              if (pipWindow) {
                await commands.closePipWindow();
              } else {
                await props.onOpenPip();
              }
            }}
            title="Open Picture in Picture"
          >
            <PictureInPicture class="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
