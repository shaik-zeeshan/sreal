import { PlayMethod } from "@jellyfin/sdk/lib/generated-client";
import { getPlaystateApi } from "@jellyfin/sdk/lib/utils/api/playstate-api";
import { useQueryClient } from "@tanstack/solid-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import { useGeneralInfo } from "~/components/current-user-provider";
import { useJellyfin } from "~/components/jellyfin-provider";
import type {
  BufferHealth,
  Chapter,
  LoadingStage,
  NetworkQuality,
  OpenPanel,
  OSDState,
  Track,
} from "~/components/video/types";
import {
  DEFAULT_AUDIO_LANG,
  DEFAULT_SUBTITLE_LANG,
} from "~/components/video/types";
import library from "~/lib/jellyfin/library";
import { commands } from "~/lib/tauri";

type ItemDetails =
  | Awaited<ReturnType<typeof library.query.getItem>>
  | undefined;

export function useVideoPlayback(
  itemId: () => string,
  itemDetails: () => ItemDetails
) {
  const jf = useJellyfin();
  const queryClient = useQueryClient();
  const { store: userStore } = useGeneralInfo();
  const [state, setState] = createStore({
    audioIndex: -1,
    subtitleIndex: -1,
    currentTime: "",
    playing: true,
    volume: 100,
    isMuted: false,
    playbackSpeed: 1,
    audioList: [] as Track[],
    subtitleList: [] as Track[],
    chapters: [] as Chapter[],
    duration: 0,
    showControls: true,
    controlsLocked: false,
    url: "",
    currentItemId: itemId(),
    isHoveringControls: false,
    // New buffering and loading states
    bufferedTime: 0,
    bufferingPercentage: 0,
    isLoading: true,
    isBuffering: false,
    isSeeking: false,
    // OSD and help states
    osd: {
      visible: false,
      type: "play" as const,
      value: null,
      icon: "Play",
      label: "",
    } as OSDState,
    showHelp: false,
    loadingStage: "connecting" as LoadingStage,
    networkQuality: "good" as NetworkQuality,
    bufferHealth: "healthy" as BufferHealth,
  });

  const [openPanel, setOpenPanel] = createSignal<OpenPanel>(null);
  const [hideControlsTimeout, setHideControlsTimeout] =
    createSignal<NodeJS.Timeout>();

  let unlistenFuncs: UnlistenFn[] = [];

  // Jellyfin playback reporting
  const playSessionId = crypto.randomUUID();
  let lastProgressReportTime = 0;

  const showControls = () => {
    if (state.controlsLocked) {
      return;
    }
    setState("showControls", true);
    commands.toggleTitlebarHide(false);

    const existing = hideControlsTimeout();
    if (existing) {
      clearTimeout(existing);
    }

    // Only set timeout to hide if not hovering over controls
    if (!state.isHoveringControls) {
      const timeout = setTimeout(() => {
        setState("showControls", false);
        commands.toggleTitlebarHide(true);
      }, 1000);

      setHideControlsTimeout(timeout);
    }
  };

  const toggleControlsLock = () => {
    setState("controlsLocked", !state.controlsLocked);
    if (state.controlsLocked) {
      // When locking, hide controls immediately
      setState("showControls", false);
      commands.toggleTitlebarHide(true);
      const existing = hideControlsTimeout();
      if (existing) {
        clearTimeout(existing);
      }
    } else {
      // When unlocking, show controls immediately
      setState("showControls", true);
      commands.toggleTitlebarHide(false);
      // Clear any existing timeout
      const existing = hideControlsTimeout();
      if (existing) {
        clearTimeout(existing);
      }
    }
  };

  const showOSD = (
    type: OSDState["type"],
    value: string | number | null,
    label?: string
  ) => {
    setState("osd", {
      visible: true,
      type,
      value,
      icon: type,
      label: label || "",
    });
  };

  const hideOSD = () => {
    setState("osd", "visible", false);
  };

  const toggleHelp = () => {
    setState("showHelp", !state.showHelp);
  };

  const updateLoadingStage = (stage: LoadingStage) => {
    setState("loadingStage", stage);
  };

  const updateNetworkQuality = (quality: NetworkQuality) => {
    setState("networkQuality", quality);
  };

  const updateBufferHealth = (health: BufferHealth) => {
    setState("bufferHealth", health);
  };

  const togglePlay = () => {
    if (state.playing) {
      commands.playbackPause();
      showOSD("pause", null, "Paused");
    } else {
      commands.playbackPlay();
      showOSD("play", null, "Playing");
    }
  };

  const toggleMute = () => {
    if (state.isMuted) {
      const lastVolume = state.volume || 100;
      commands.playbackVolume(lastVolume);
      setState("volume", lastVolume);
      setState("isMuted", false);
      showOSD("unmute", lastVolume, "Unmuted");
    } else {
      commands.playbackVolume(0);
      setState("isMuted", true);
      showOSD("mute", 0, "Muted");
    }
  };

  const handleVolumeChange = (value: number) => {
    const newVolume = Math.round(value);
    commands.playbackVolume(newVolume);
    setState("volume", newVolume);
    setState("isMuted", newVolume === 0);
    showOSD("volume", newVolume);
  };

  const setSpeed = (speed: number) => {
    commands.playbackSpeed(speed);
    setState("playbackSpeed", speed);
    showOSD("speed", speed);
  };

  const navigateToChapter = (chapter: Chapter) => {
    // Convert ticks to seconds (1 tick = 100 nanoseconds = 0.0000001 seconds)
    const startTimeSeconds = chapter.startPositionTicks / 10_000_000;

    // Use relative time approach like handleProgressClick
    const currentTime = Number(state.currentTime);
    const relativeTime = startTimeSeconds - currentTime;

    // Set seeking state
    setState("isSeeking", true);
    showControls();

    commands.playbackSeek(relativeTime);

    // Reset seeking state after a delay
    setTimeout(() => {
      setState("isSeeking", false);
    }, 1000);

    // Don't immediately update state - let Tauri's playback-time event handle it
    // This prevents the state from being overwritten by stale time events
  };

  const handleProgressClick = (value: number) => {
    if (state.duration === 0) {
      return;
    }
    const newTime = (value / 100) * state.duration;
    const relativeTime = newTime - Number(state.currentTime);

    // Set seeking state
    setState("isSeeking", true);
    showControls();

    commands.playbackSeek(relativeTime);
    setState("currentTime", newTime.toString());

    // Reset seeking state after a delay
    setTimeout(() => {
      setState("isSeeking", false);
    }, 1000);
  };

  const handleOpenPip = async () => {
    try {
      await commands.openPipWindow();
      showOSD("play", null, "Picture in Picture opened");
    } catch (error) {
      showOSD("play", null, "Picture in Picture failed to open");
    }
  };

  const loadNewVideo = (url: string, newItemId: string) => {
    setState("url", url);
    setState("currentItemId", newItemId);
    setState("currentTime", "0");
    setState("duration", 0);
    setState("playing", true);
    // Reset buffering and loading states for new video
    setState("bufferedTime", 0);
    setState("bufferingPercentage", 0);
    setState("isLoading", true);
    setState("isBuffering", false);
    setState("isSeeking", false);
    commands.playbackLoad(url);
  };

  const handleControlMouseEnter = () => {
    setState("isHoveringControls", true);
    // Clear any existing timeout when entering control area
    const existing = hideControlsTimeout();
    if (existing) {
      clearTimeout(existing);
    }
  };

  const handleControlMouseLeave = () => {
    setState("isHoveringControls", false);
    // Start timeout to hide controls when leaving control area
    if (!state.controlsLocked) {
      const timeout = setTimeout(() => {
        setState("showControls", false);
        commands.toggleTitlebarHide(true);
      }, 1000);
      setHideControlsTimeout(timeout);
    }
  };

  createEffect(() => {
    const currentItemId = itemId();
    const token = jf.api?.accessToken;
    const basePath = jf.api?.basePath;

    if (!(token && jf.api && currentItemId)) {
      return;
    }

    const url = `${basePath}/Videos/${currentItemId}/Stream?api_key=${token}&container=mp4&static=true`;
    setState("url", url);
    setState("currentItemId", currentItemId);
    setState("currentTime", "0");
    setState("duration", 0);

    commands.playbackLoad(url);
    commands.playbackPlay();
  });

  createEffect(() => {
    let chapters: Chapter[] = [];

    // Check for chapters in different possible fields
    if (itemDetails()?.Chapters && Array.isArray(itemDetails()?.Chapters)) {
      chapters =
        (itemDetails()?.Chapters?.map((chapter) => ({
          startPositionTicks: chapter?.StartPositionTicks || 0,
          name: chapter?.Name || null,
          imagePath: chapter?.ImagePath || null,
          imageDateModified: chapter?.ImageDateModified || null,
          imageTag: chapter?.ImageTag || null,
        })) as Chapter[]) ?? [];
    }
    setState("chapters", chapters);
  });

  createEffect(() => {
    // console.log("userProgress", userProgress);
    // setState("currentTime", userProgress.toString());
  });

  createEffect(async () => {
    const currentItemId = itemId();
    // Clean up existing listeners when itemId changes
    unlistenFuncs.forEach((unlisten) => {
      unlisten();
    });
    unlistenFuncs = [];

    const fileLoaded = await listen("file-loaded", async (event) => {
      // Reset loading state when file is loaded
      setState("isLoading", false);
      setState("isBuffering", false);
      commands.playbackPlay();

      const [currentTime, duration] = event.payload as [number, number];

      if (Number(state.currentTime) > 0) {
        commands.playbackSeek(Number(state.currentTime));
      } else {
        const userProgress = itemDetails()?.UserData?.PlaybackPositionTicks
          ? (itemDetails()?.UserData?.PlaybackPositionTicks as number) /
            10_000_000
          : 0;

        if (userProgress > 0 && userProgress !== Number(currentTime)) {
          commands.playbackSeek(userProgress);
        }
      }

      try {
        if (!jf.api) {
          return;
        }
        const playstateApi = getPlaystateApi(jf.api);
        await playstateApi.reportPlaybackStart({
          playbackStartInfo: {
            ItemId: currentItemId,
            PlaySessionId: playSessionId,
            CanSeek: true,
            IsPaused: false,
            IsMuted: state.isMuted,
            VolumeLevel: Math.min(state.volume, 100), // Clamp to 100 for Jellyfin
            PlayMethod: PlayMethod.DirectStream,
            AudioStreamIndex:
              state.audioIndex >= 0 ? state.audioIndex : undefined,
            SubtitleStreamIndex:
              state.subtitleIndex > 0 ? state.subtitleIndex : undefined,
          },
        });

        // Initialize last progress report time
        lastProgressReportTime = Date.now();
      } catch (_error) {
        // Do nothing
      }
    });

    unlistenFuncs.push(fileLoaded);

    const playbackTime = await listen("playback-time", async (event) => {
      const newTime = event.payload as string;

      // Batch state updates for better performance
      setState({
        currentTime: newTime,
        // Reset seeking state if we're getting time updates
        isSeeking: false,
      });

      // Report progress to Jellyfin every 3 seconds
      const now = Date.now();
      if (now - lastProgressReportTime >= 3000 && jf.api) {
        lastProgressReportTime = now;
        try {
          const playstateApi = getPlaystateApi(jf.api);
          await playstateApi.reportPlaybackProgress({
            playbackProgressInfo: {
              ItemId: currentItemId,
              PlaySessionId: playSessionId,
              PositionTicks: Math.floor(Number(newTime) * 10_000_000),
              IsPaused: !state.playing,
              IsMuted: state.isMuted,
              VolumeLevel: Math.min(state.volume, 100),
              CanSeek: true,
              PlayMethod: PlayMethod.DirectStream,
              AudioStreamIndex:
                state.audioIndex >= 0 ? state.audioIndex : undefined,
              SubtitleStreamIndex:
                state.subtitleIndex > 0 ? state.subtitleIndex : undefined,
            },
          });
        } catch (_error) {
          // Do nothing
        }
      }
    });

    unlistenFuncs.push(playbackTime);

    const pause = await listen("pause", (event) => {
      setState("playing", !(event.payload as boolean));
    });

    unlistenFuncs.push(pause);

    const audioList = await listen("audio-list", async (event) => {
      setState("audioList", event.payload as Track[]);
      if (state.audioIndex > -1) {
        return;
      }
      const defaultAudio = (event.payload as Track[]).find((track) =>
        DEFAULT_AUDIO_LANG.includes(track.lang ?? "")
      );
      if (defaultAudio) {
        await commands.playbackChangeAudio(defaultAudio.id.toString());
        setState("audioIndex", defaultAudio.id as number);
      } else if ((event.payload as Track[]).length > 0) {
        await commands.playbackChangeAudio(state.audioList[0].id.toString());
        setState("audioIndex", state.audioList[0].id);
      }
    });

    unlistenFuncs.push(audioList);

    const subtitleList = await listen("subtitle-list", async (event) => {
      setState("subtitleList", event.payload as Track[]);
      if (state.subtitleIndex > -1) {
        return;
      }
      const defaultSubtitle = (event.payload as Track[]).find((track) =>
        DEFAULT_SUBTITLE_LANG.includes(track.lang ?? "")
      );
      if (defaultSubtitle) {
        await commands.playbackChangeSubtitle(defaultSubtitle.id.toString());
        setState("subtitleIndex", defaultSubtitle.id);
      } else if ((event.payload as Track[]).length > 0) {
        await commands.playbackChangeSubtitle(
          state.subtitleList[0].id.toString()
        );
        setState("subtitleIndex", state.subtitleList[0].id);
      }
    });

    unlistenFuncs.push(subtitleList);

    const duration = await listen("duration", (event) => {
      setState("duration", Number(event.payload as string));
    });

    unlistenFuncs.push(duration);

    const aid = await listen("aid", (event) => {
      setState("audioIndex", Number(event.payload as string));
    });

    unlistenFuncs.push(aid);

    const sid = await listen("sid", (event) => {
      setState("subtitleIndex", Number(event.payload as string));
    });

    unlistenFuncs.push(sid);

    const speed = await listen("speed", (event) => {
      setState("playbackSpeed", Number(event.payload as string));
    });

    unlistenFuncs.push(speed);

    // Cache and buffering event listeners with debouncing
    let cacheUpdateTimeout: NodeJS.Timeout;
    const cacheTime = await listen("cache-time", (event) => {
      const currentTime = Number(state.currentTime);
      const bufferedDuration = Number(event.payload as number);

      // Debounce cache updates to prevent excessive re-renders
      clearTimeout(cacheUpdateTimeout);
      cacheUpdateTimeout = setTimeout(() => {
        setState("bufferedTime", Math.max(0, currentTime + bufferedDuration));

        // Update loading state based on buffer
        if (state.isLoading && bufferedDuration > 0) {
          setState("isLoading", false);
        }
      }, 100);
    });

    unlistenFuncs.push(cacheTime);

    const bufferingState = await listen("buffering-state", (event) => {
      const percentage = Number(event.payload as number);

      // Only update if percentage changed significantly to reduce re-renders
      const currentPercentage = state.bufferingPercentage;
      if (Math.abs(percentage - currentPercentage) > 1) {
        setState("bufferingPercentage", Math.max(0, Math.min(100, percentage)));

        // Determine if we're actively buffering
        const wasBuffering = state.isBuffering;
        const isNowBuffering = percentage < 100 && percentage > 0;

        if (isNowBuffering !== wasBuffering) {
          setState("isBuffering", isNowBuffering);

          // Show controls when buffering starts
          if (isNowBuffering) {
            showControls();
          }
        }
      }
    });

    unlistenFuncs.push(bufferingState);

    const pausedForCache = await listen("paused-for-cache", (event) => {
      const isPaused = event.payload as boolean;

      // Only update if state actually changed
      if (state.isBuffering !== isPaused) {
        setState("isBuffering", isPaused);

        // Show controls when paused for cache
        if (isPaused) {
          showControls();
        }
      }
    });

    unlistenFuncs.push(pausedForCache);
  });

  const offFullscreenIfOnWhenCleanup = async () => {
    const window = getCurrentWindow();
    if (await window.isFullscreen()) {
      commands.toggleFullscreen();
    }
  };

  onCleanup(async () => {
    offFullscreenIfOnWhenCleanup();
    unlistenFuncs.forEach((unlisten) => {
      unlisten();
    });
    clearTimeout(hideControlsTimeout());

    // Report playback stopped to Jellyfin
    if (jf.api) {
      try {
        const playstateApi = getPlaystateApi(jf.api);
        await playstateApi.reportPlaybackStopped({
          playbackStopInfo: {
            ItemId: itemId(),
            PlaySessionId: playSessionId,
            PositionTicks: Math.floor(Number(state.currentTime) * 10_000_000),
          },
        });
      } catch (_error) {
        // Do nothing
      }
    }

    commands.toggleTitlebarHide(false);
    commands.playbackClear();
  });

  const onEndOfFile = async () => {
    const queryKey = [
      library.query.getItem.key,
      library.query.getItem.keyFor(itemId(), userStore?.user?.Id),
    ];
    await queryClient.invalidateQueries({
      queryKey,
    });

    if (!jf.api) {
      return;
    }

    const playstateApi = getPlaystateApi(jf.api);
    await playstateApi.reportPlaybackStopped({
      playbackStopInfo: {
        ItemId: itemId(),
        PlaySessionId: playSessionId,
        PositionTicks: Math.floor(Number(state.currentTime) * 10_000_000),
      },
    });
  };

  return {
    state,
    setState,
    openPanel,
    setOpenPanel,
    showControls,
    toggleControlsLock,
    togglePlay,
    toggleMute,
    handleVolumeChange,
    setSpeed,
    handleProgressClick,
    handleOpenPip,
    loadNewVideo,
    handleControlMouseEnter,
    handleControlMouseLeave,
    navigateToChapter,
    // OSD and help functions
    showOSD,
    hideOSD,
    toggleHelp,
    updateLoadingStage,
    updateNetworkQuality,
    updateBufferHealth,
    onEndOfFile,
  };
}
