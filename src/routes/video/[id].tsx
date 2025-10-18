import {
  type RouteSectionProps,
  useNavigate,
  useParams,
} from "@solidjs/router";
import { ArrowLeft, Eye, EyeOff } from "lucide-solid";
import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { useGeneralInfo } from "~/components/current-user-provider";
import {
  AutoplayOverlay,
  BufferingIndicator,
  KeyboardShortcutsHelp,
  LoadingSpinner,
  OpenInIINAButton,
  OSD,
  VideoControls,
  VideoInfoOverlay,
  VideoSettingsPanels,
} from "~/components/video";
import { useAutoplay } from "~/hooks/useAutoplay";
import { useVideoKeyboardShortcuts } from "~/hooks/useVideoKeyboardShortcuts";
import { useVideoPlayback } from "~/hooks/useVideoPlayback";
import library from "~/lib/jellyfin/library";
import { commands } from "~/lib/tauri";
import { createJellyFinQuery } from "~/lib/utils";

export default function Page(_props: RouteSectionProps) {
  // let [{ params }] = splitProps(props, ['params']);
  const navigate = useNavigate();
  const routeParams = useParams();
  const { store: userStore } = useGeneralInfo();

  // Fetch item details with UserData to get playback position
  const itemDetails = createJellyFinQuery(() => ({
    queryKey: [
      library.query.getItem.key,
      library.query.getItem.keyFor(routeParams.id, userStore?.user?.Id),
    ],
    queryFn: (jf) => {
      if (!routeParams.id) {
        throw new Error("Route parameter ID not found");
      }
      return library.query.getItem(jf, routeParams.id, userStore?.user?.Id, [
        "Overview",
        "ParentId",
      ]);
    },
    enabled: !!routeParams.id && !!userStore?.user?.Id,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    staleTime: Number.POSITIVE_INFINITY, // 5 minutes
  }));

  const parentDetails = createJellyFinQuery(() => ({
    queryKey: [
      library.query.getItem.key,
      library.query.getItem.keyFor(
        itemDetails.data?.ParentId || "",
        userStore?.user?.Id
      ),
      itemDetails.data?.ParentId,
    ],
    queryFn: (jf) => {
      const parentId = itemDetails.data?.ParentId;
      if (!parentId) {
        throw new Error("Parent ID not found");
      }
      return library.query.getItem(jf, parentId, userStore?.user?.Id, [
        "Overview",
        "ParentId",
      ]);
    },

    enabled:
      !!itemDetails.data?.ParentId &&
      itemDetails.data?.Type !== "Movie" &&
      !!userStore?.user?.Id,
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 3,
  }));

  // Use the custom hook for playback state management
  const {
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
    showOSD,
    hideOSD,
    toggleHelp,
    onEndOfFile,
  } = useVideoPlayback(
    () => routeParams.id,
    () => itemDetails.data
  );

  // Use autoplay hook - don't destructure to maintain reactivity
  const autoplayHook = useAutoplay({
    currentItemId: () => routeParams.id,
    currentItemDetails: itemDetails,
    onLoadNewVideo: loadNewVideo,
    playbackState: {
      currentTime: () => state.currentTime,
      duration: () => state.duration,
    },
    onEndOfFile,
  });

  let audioBtnRef!: HTMLButtonElement;
  let subsBtnRef!: HTMLButtonElement;
  let speedBtnRef!: HTMLButtonElement;
  let panelRef!: HTMLButtonElement;

  // Use keyboard shortcuts hook
  useVideoKeyboardShortcuts({
    state,
    openPanel,
    setOpenPanel,
    togglePlay,
    toggleMute,
    handleVolumeChange,
    setSpeed,
    showControls,
    navigateToChapter,
    toggleHelp,
    showOSD,
  });

  // Close panel when clicking outside
  createEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panelRef) {
        return;
      }
      const t = e.target as Node;
      if (panelRef.contains(t)) {
        return;
      }
      if (audioBtnRef?.contains(t)) {
        return;
      }
      if (subsBtnRef?.contains(t)) {
        return;
      }
      if (speedBtnRef?.contains(t)) {
        return;
      }
      setOpenPanel(null);
    };
    document.addEventListener("mousedown", onDown);
    onCleanup(() => document.removeEventListener("mousedown", onDown));
  });

  // Ctrl+scroll for volume control
  createEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -5 : 5;
        const newVolume = Math.max(0, Math.min(200, state.volume + delta));
        handleVolumeChange(newVolume);
        showControls();
      }
    };
    document.addEventListener("wheel", handleWheel, { passive: false });
    onCleanup(() => document.removeEventListener("wheel", handleWheel));
  });

  // Add mouse enter/leave handlers to all control elements
  onMount(() => {
    let cleanupFunctions: (() => void)[] = [];

    const addControlListeners = () => {
      // Clean up existing listeners first
      cleanupFunctions.forEach((cleanup) => {
        cleanup();
      });
      cleanupFunctions = [];

      const controlElements = document.querySelectorAll(".control-element");
      controlElements.forEach((element) => {
        element.addEventListener("mouseenter", handleControlMouseEnter);
        element.addEventListener("mouseleave", handleControlMouseLeave);

        // Store cleanup function for this element
        cleanupFunctions.push(() => {
          element.removeEventListener("mouseenter", handleControlMouseEnter);
          element.removeEventListener("mouseleave", handleControlMouseLeave);
        });
      });
    };

    // Add listeners after a short delay to ensure DOM is ready
    const timeout = setTimeout(addControlListeners, 100);

    // Re-add listeners when controls visibility changes (DOM updates)
    createEffect(() => {
      if (state.showControls) {
        // Small delay to ensure DOM is updated
        setTimeout(addControlListeners, 50);
      }
    });

    onCleanup(() => {
      clearTimeout(timeout);
      cleanupFunctions.forEach((cleanup) => {
        cleanup();
      });
    });
  });

  const handleMouseMove = (e: MouseEvent) => {
    if (!state.controlsLocked) {
      // Check if mouse is over any control element
      const target = e.target as HTMLElement;
      if (
        target.classList.contains("control-element") ||
        target.closest(".control-element")
      ) {
        return; // Don't show controls when hovering over control elements
      }
      showControls();
    }
  };

  const handleWindowClick = (e: MouseEvent) => {
    // Check if clicking on any control element
    const target = e.target as HTMLElement;
    if (panelRef?.contains(target)) {
      return;
    }
    if (audioBtnRef?.contains(target)) {
      return;
    }
    if (subsBtnRef?.contains(target)) {
      return;
    }
    if (speedBtnRef?.contains(target)) {
      return;
    }
    if (
      target.classList.contains("control-element") ||
      target.closest(".control-element")
    ) {
      return;
    }

    if (state.showControls) {
      // Hide controls immediately
      setState("showControls", false);
      commands.toggleTitlebarHide(true);
    } else {
      // Show controls
      showControls();
    }
  };

  return (
    <div
      class="dark relative flex h-full w-full flex-col gap-2 overflow-hidden bg-transparent"
      onClick={handleWindowClick}
      onMouseMove={handleMouseMove}
      role="button"
    >
      {/* Initial Loading Overlay */}
      <Show when={state.isLoading}>
        <div class="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <LoadingSpinner
            loadingStage={state.loadingStage}
            progress={state.bufferingPercentage}
            size="lg"
            text="Loading video..."
          />
        </div>
      </Show>

      {/* Buffering Overlay */}
      <Show when={state.isBuffering && !state.isLoading}>
        <div class="absolute inset-0 z-40 flex items-center justify-center">
          <BufferingIndicator
            bufferHealth={state.bufferHealth}
            bufferingPercentage={state.bufferingPercentage}
            isBuffering={state.isBuffering}
            networkQuality={state.networkQuality}
            showText
            variant="overlay"
          />
        </div>
      </Show>
      {/* Lock Button - Always Visible */}
      <button
        aria-label={
          state.controlsLocked ? "Unlock controls" : "Lock controls hidden"
        }
        class="control-element fixed top-6 right-4 z-50 rounded-full bg-black/60 p-3 text-white transition-all hover:bg-black/80"
        onClick={(e) => {
          e.stopPropagation();
          toggleControlsLock();
        }}
      >
        <Show fallback={<Eye class="h-5 w-5" />} when={state.controlsLocked}>
          <EyeOff class="h-5 w-5" />
        </Show>
      </button>

      <Show when={state.showControls}>
        {/* Item Info Overlay */}
        <VideoInfoOverlay
          itemDetails={itemDetails}
          parentDetails={parentDetails}
        />

        {/* Bottom Controls */}
        <div
          class="control-element pointer-events-none fixed right-0 bottom-0 left-0 p-4"
          onClick={(e) => e.stopPropagation()}
          role="button"
        >
          <div class="pointer-events-auto relative mx-auto flex w-full max-w-4xl flex-col gap-3">
            {/* Dropdown Panels */}
            <VideoSettingsPanels
              onNavigateToChapter={navigateToChapter}
              openPanel={openPanel()}
              panelRef={panelRef}
              setOpenPanel={setOpenPanel}
              setState={setState}
              state={state}
            />

            {/* Main Control Bar */}
            <VideoControls
              audioBtnRef={audioBtnRef}
              onNavigateToChapter={navigateToChapter}
              onOpenPip={handleOpenPip}
              onProgressClick={handleProgressClick}
              onSetSpeed={setSpeed}
              onToggleMute={toggleMute}
              onTogglePlay={togglePlay}
              onVolumeChange={handleVolumeChange}
              openPanel={openPanel}
              setOpenPanel={setOpenPanel}
              speedBtnRef={speedBtnRef}
              state={state}
              subsBtnRef={subsBtnRef}
            />
          </div>
        </div>

        {/* Back Button */}
        <button
          class="control-element fixed top-6 left-4 z-50 rounded-full p-3 text-white transition-all"
          onClick={(e) => {
            e.stopPropagation();
            commands.playbackClear();
            navigate(-1);
          }}
        >
          <ArrowLeft class="h-6 w-6" />
        </button>

        {/* IINA Button */}
        <Show when={state.url.length}>
          <div
            class="control-element fixed top-8 right-20 z-50"
            onClick={(e) => e.stopPropagation()}
            role="button"
          >
            <OpenInIINAButton
              beforePlaying={() => {
                commands.playbackPause();
              }}
              url={state.url}
            />
          </div>
        </Show>
      </Show>

      {/* Autoplay Overlay */}
      <div
        class="control-element"
        onClick={(e) => e.stopPropagation()}
        role="button"
      >
        <AutoplayOverlay
          isCollapsed={autoplayHook().isCollapsed()}
          isVisible={autoplayHook().showAutoplay()}
          nextEpisode={
            autoplayHook().nextEpisode as Awaited<
              ReturnType<typeof library.query.getNextEpisode>
            >
          }
          onCancel={autoplayHook().cancelAutoplay}
          onPlayNext={() => {
            // before playing the next episode, clear the current video
            commands.playbackPause();
            autoplayHook().playNextEpisode();
          }}
          setIsCollapsed={autoplayHook().setIsCollapsed}
        />
      </div>

      {/* OSD (On-Screen Display) */}
      <OSD onHide={hideOSD} state={state.osd} />

      {/* Keyboard Shortcuts Help Overlay */}
      <KeyboardShortcutsHelp onClose={toggleHelp} visible={state.showHelp} />
    </div>
  );
}
