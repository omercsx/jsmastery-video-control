// This script runs directly in the context of the web page

// Keep track of whether we're in the main script instance
let isMainScriptInstance = true;

// Use a command processing lock to prevent multiple instances from processing the same command
let isProcessingCommand = false;

// Global command lock using localStorage
const COMMAND_LOCK_KEY = 'jsmastery_videocontrol_command_lock';
const COMMAND_LOCK_EXPIRY = 'jsmastery_videocontrol_lock_expiry';
const LAST_COMMAND_TIMESTAMP = 'jsmastery_videocontrol_last_timestamp';

// Function to acquire a command lock
function acquireCommandLock() {
  // Check if lock exists and is still valid
  const currentLock = localStorage.getItem(COMMAND_LOCK_KEY);
  const expiryTime = localStorage.getItem(COMMAND_LOCK_EXPIRY);

  if (currentLock && expiryTime && parseInt(expiryTime) > Date.now()) {
    // Lock exists and is still valid
    return false;
  }

  // Set a new lock
  const lockId = Date.now().toString() + Math.random().toString().substr(2, 8);
  localStorage.setItem(COMMAND_LOCK_KEY, lockId);
  localStorage.setItem(COMMAND_LOCK_EXPIRY, Date.now() + 1000); // 1 second expiry

  // Verify we got the lock (in case of race conditions)
  return localStorage.getItem(COMMAND_LOCK_KEY) === lockId;
}

// Function to release the command lock
function releaseCommandLock() {
  localStorage.removeItem(COMMAND_LOCK_KEY);
  localStorage.removeItem(COMMAND_LOCK_EXPIRY);
}

// Store direct reference to video element when found
let cachedVideoElement = null;

// Function to prevent default actions once
function preventDefaultOnce(e) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Respond to ping to confirm content script is running
  if (message.action === 'ping') {
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'controlVideo') {
    // If another instance is already processing a command, ignore this one
    if (isProcessingCommand) {
      sendResponse({ success: false, reason: 'duplicate-instance' });
      return true;
    }

    // Check for duplicate commands using timestamp
    if (message.timestamp) {
      const lastTimestamp = parseInt(localStorage.getItem(LAST_COMMAND_TIMESTAMP) || '0');
      if (message.timestamp - lastTimestamp < 500) {
        sendResponse({ success: false, reason: 'duplicate-timestamp' });
        return true;
      }

      // Store this command's timestamp
      localStorage.setItem(LAST_COMMAND_TIMESTAMP, message.timestamp.toString());
    }

    // Try to acquire the global command lock
    if (!acquireCommandLock()) {
      sendResponse({ success: false, reason: 'locked' });
      return true;
    }

    try {
      // Set processing lock to prevent multiple instances from handling the same command
      isProcessingCommand = true;

      const command = message.command;

      // Prevent any default actions from the website when our commands run
      const preventHandler = (e) => preventDefaultOnce(e);
      document.addEventListener('keydown', preventHandler, true);
      document.addEventListener('keyup', preventHandler, true);

      // For play-pause, try multiple approaches immediately
      if (command === 'play-pause') {

        // Try multiple approaches for play/pause
        const videos = document.querySelectorAll('video');
        let success = false;

        // First try direct video control (most reliable)
        if (videos.length > 0) {
          let video = videos[0];

          // Try to find the most active video
          for (const v of videos) {
            if (!v.paused) {
              video = v;
              break;
            }
          }

          if (video.paused) {
            try {
              const playPromise = video.play();
              if (playPromise !== undefined) {
                playPromise.then(() => {
                  success = true;
                }).catch(error => {
                  console.error('Error playing video:', error);
                });
              }
            } catch (e) {
              console.error("Error during play:", e);
            }
          } else {
            try {
              video.pause();
              success = true;
            } catch (e) {
              console.error("Error during pause:", e);
            }
          }
        }

        // Also try clicking buttons (can't hurt to try both approaches)
        const exactButton = findExactButton(command);
        if (exactButton) {
          tryButtonClick(exactButton);
          success = true;
        }

        // As a fallback, try a spacebar press
        if (!success) {
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: ' ',
            code: 'Space',
            keyCode: 32,
            which: 32,
            bubbles: true,
            cancelable: true
          }));

          setTimeout(() => {
            document.dispatchEvent(new KeyboardEvent('keyup', {
              key: ' ',
              code: 'Space',
              keyCode: 32,
              which: 32,
              bubbles: true,
              cancelable: true
            }));
          }, 50);
        }

        // Clean up and respond
        setTimeout(() => {
          document.removeEventListener('keydown', preventHandler, true);
          document.removeEventListener('keyup', preventHandler, true);
        }, 200);

        // Release locks and respond
        isProcessingCommand = false;
        releaseCommandLock();
        sendResponse({ success: true });
        return true;
      }

      // For other commands, or if play-pause button not found, use regular flow
      const success = performVideoControl(command);

      // Clean up event listeners after a short delay
      setTimeout(() => {
        document.removeEventListener('keydown', preventHandler, true);
        document.removeEventListener('keyup', preventHandler, true);
      }, 200);

      // Release the processing lock
      isProcessingCommand = false;

      // Release global lock
      releaseCommandLock();

      sendResponse({ success: success });

      // If this instance failed but got a response, mark as secondary
      if (!success) {
        isMainScriptInstance = false;
      }
    } catch (error) {
      console.error('Error processing command:', error);
      isProcessingCommand = false;
      releaseCommandLock();
      sendResponse({ success: false, error: error.message });
    }
  }
  return true; // Keep the message channel open for asynchronous response
});

// Function to control video based on commands
function performVideoControl(command) {
  // First try the direct button approach (most reliable for Plyr)
  const exactButton = findExactButton(command);
  if (exactButton) {
    const clickResult = tryButtonClick(exactButton);
    if (clickResult) {
      return true; // Exit immediately on success
    }
  }

  // If direct button approach fails, continue with pattern matching
  const playerPatterns = trySpecificPlayerPatterns();
  if (playerPatterns.length > 0) {
    for (const pattern of playerPatterns) {
      let foundButton = null;
      for (const btn of pattern.buttons) {
        const btnDataPlyr = btn.getAttribute('data-plyr');
        const ariaLabel = (btn.getAttribute('aria-label') || "").toLowerCase();
        const title = (btn.getAttribute('title') || "").toLowerCase();
        const innerText = (btn.textContent || "").toLowerCase();

        // Get SVG use href from button - check both href and xlink:href
        let svgUseHref = "";
        const svgUse = btn.querySelector('svg use');
        if (svgUse) {
          // Check both href and xlink:href (some players use one, some use the other)
          svgUseHref = (svgUse.getAttribute('xlink:href') || svgUse.getAttribute('href') || "").toLowerCase();
        }

        // Check for buttons we NEVER want to click (notification, search, etc.)
        if (
          innerText.includes("next lesson") ||
          innerText.includes("check answer") ||
          ariaLabel.includes("next lesson") ||
          innerText.includes("search") ||
          ariaLabel.includes("notification") ||
          (btn.querySelector('svg path') && !svgUseHref) // Skip buttons with SVG paths but no href 
        ) {

          continue; // Skip this button entirely
        }

        let isMatch = false;
        if (command === 'play-pause') {
          if (
            btnDataPlyr === 'play' ||
            ariaLabel.includes('play') || ariaLabel.includes('pause') ||
            title.includes('play') || title.includes('pause') ||
            innerText.includes('play') || innerText.includes('pause') ||
            svgUseHref.includes('plyr-play') || svgUseHref.includes('plyr-pause')
          ) {
            isMatch = true;
          }
        } else if (command === 'rewind') {
          if (
            btnDataPlyr === 'rewind' ||
            ariaLabel.includes('rewind') ||
            title.includes('rewind') ||
            innerText.includes('rewind') ||
            svgUseHref.includes('plyr-rewind')
          ) {
            isMatch = true;
          }
        } else if (command === 'fast-forward') {
          // Be EXTREMELY precise for fast-forward to avoid clicking the wrong button
          if (
            btnDataPlyr === 'fast-forward' ||
            ariaLabel === 'forward 10s' ||
            title === 'forward 10s' ||
            svgUseHref.includes('plyr-fast-forward') ||
            // Check if inner span contains EXACTLY "Forward 10s"
            (btn.querySelector('.plyr__sr-only') &&
              btn.querySelector('.plyr__sr-only').textContent.trim() === 'Forward 10s')
          ) {
            isMatch = true;
          }

          // Ensure we're NOT matching a rewind button
          if (
            btnDataPlyr === 'rewind' ||
            ariaLabel.includes('rewind') ||
            title.includes('rewind') ||
            innerText.includes('rewind') ||
            svgUseHref.includes('plyr-rewind')
          ) {

            isMatch = false;
          }
        }


        if (isMatch) {
          foundButton = btn;
          break;
        }
      }

      if (foundButton) {
        try {
          // Use our new tryButtonClick method for more reliable clicking
          const success = tryButtonClick(foundButton);
          if (success) {
            return true; // Exit immediately on success
          }
        } catch (e) {
          console.error('Error with specific pattern approach:', e);
        }
      }
    }
  }

  // Try direct HTML5 approach next
  const html5Result = tryHTML5VideoMethod(command);
  if (html5Result) {

    return true;
  }

  // Final fallbacks if nothing else worked
  if (command === 'rewind') {
    const rewindResult = tryRewindFallback();
    if (rewindResult) {

      return true;
    }
  } else if (command === 'play-pause') {
    const playPauseResult = tryPlayPauseFallback();
    if (playPauseResult) {

      return true;
    }
  } else if (command === 'fast-forward') {
    const fastForwardResult = tryFastForwardSafely();
    if (fastForwardResult) {

      return true;
    }
  }

  // If all else fails, try keyboard events as a last resort
  const keyboardResult = tryKeyboardMethod(command);
  if (keyboardResult) {

    return true;
  }

  console.error('Failed to control video with command:', command);
  return false;
}

// Method for directly controlling HTML5 video elements
function tryHTML5VideoMethod(command) {
  try {
    // First check if we already have a cached video element
    if (!cachedVideoElement) {


      // Find all video elements on the page
      let videos = document.querySelectorAll('video');


      // If no videos found directly, try finding in iframes
      if (videos.length === 0) {
        try {
          // Try to access videos in all iframes
          const iframes = document.querySelectorAll('iframe');


          for (const iframe of iframes) {
            try {
              if (iframe.contentDocument && iframe.contentDocument.querySelectorAll) {
                const iframeVideos = iframe.contentDocument.querySelectorAll('video');
                if (iframeVideos.length > 0) {

                  videos = iframeVideos;
                  break;
                }
              }
            } catch (frameError) {
            }
          }
        } catch (iframeError) {
          console.error('Error trying to find videos in iframes:', iframeError);
        }
      }

      // If we found videos, cache the first one that appears to be playing
      if (videos.length > 0) {
        // Try to get the most relevant video (the one that's playing or longest)
        let bestVideo = videos[0];
        let bestVideoDuration = 0;

        for (const video of videos) {
          // If any video is currently playing, pick it immediately
          if (!video.paused) {
            bestVideo = video;
            break;
          }

          // Otherwise pick the longest video (likely the main content)
          if (video.duration > bestVideoDuration) {
            bestVideo = video;
            bestVideoDuration = video.duration;
          }
        }

        // Cache the best video element for future use
        cachedVideoElement = bestVideo;
        ;
      } else {
        return false; // No videos found
      }
    }

    // Use the cached video element
    const video = cachedVideoElement;

    switch (command) {
      case 'fast-forward':
        // Skip looking for video element and use clickOnlyForwardButton()
        return clickOnlyForwardButton();
      case 'rewind':
        // Skip looking for video element and use clickOnlyRewindButton()
        return clickOnlyRewindButton();
      case 'play-pause':
        // Toggle play/pause
        if (video.paused) {
          const playPromise = video.play();
          // Handle the play promise to avoid uncaught promise errors
          if (playPromise !== undefined) {
            playPromise
              .then(() => { })
              .catch(error => {
                console.error('Error playing video:', error);
                return false;
              });
          }
        } else {
          video.pause();
        }
        return true;
    }
  } catch (e) {
    console.error('Error in HTML5 video method:', e);
    return false;
  }

  return false; // Method failed
}

// Special method for directly targeting specific player control patterns
function trySpecificPlayerPatterns() {

  const groupSelectors = [
    '.plyr__controls', // Plyr specific
    '.ytp-left-controls', '.ytp-chrome-bottom', // YouTube specific
    '.vjs-control-bar', // VideoJS specific
    '.mejs__controls', // MediaElementJS specific
    '[class*="video-controls"]', // Generic
    '[class*="media-controls"]', // Generic
    '[class*="player-controls"]', // Generic
    // Broader selectors as fallback for groups
    '[class*="controls"]',
    '[class*="Controls"]'
    // Removed '[class*="player"]' and '[class*="Player"]' as they are too broad for control groups
  ];

  const playerPatterns = [];

  for (const selector of groupSelectors) {
    const controlGroupsOnPage = document.querySelectorAll(selector);
    if (controlGroupsOnPage.length > 0) {
      ;
    }
    for (const group of controlGroupsOnPage) {
      // Check if this group element has already been added to playerPatterns by a more specific selector
      let alreadyProcessed = playerPatterns.some(p => p.element === group);
      if (alreadyProcessed) {
        continue;
      }

      const buttonsInGroup = Array.from(group.querySelectorAll('button'));

      if (buttonsInGroup.length > 0) { // A group is only interesting if it has buttons
        playerPatterns.push({
          type: 'control-group', // Generic type indicating a collection of control buttons
          element: group, // The group DOM element
          buttons: buttonsInGroup // All button DOM elements within this group
        });
      }
    }
  }

  // Deduplicate patterns based on the group element, as different selectors might find the same group
  // This is slightly redundant if the check inside the loop works well, but good as a safeguard.
  const uniquePatterns = [];
  const seenElements = new Set();
  for (const p of playerPatterns) {
    if (!seenElements.has(p.element)) {
      uniquePatterns.push(p);
      seenElements.add(p.element);
    }
  }

  ;
  return uniquePatterns;
}

// Aggressive method to try multiple ways to click the buttons
function clickVideoButtonAggressively(command) {
  try {
    // First try the specific player patterns based on the screenshot
    const playerPatterns = trySpecificPlayerPatterns();
    if (playerPatterns.length > 0) {
      // Map commands to positions in the control layout (based on screenshot)
      const positionMap = {
        'play-pause': 0,   // Left button (pause)
        'rewind': 1,       // Middle button (-10s)
        'fast-forward': 2  // Right button (+10s)
      };

      const targetIndex = positionMap[command];

      for (const pattern of playerPatterns) {
        if (pattern.type === '3-button-row' && targetIndex < pattern.buttons.length) {
          const targetButton = pattern.buttons[targetIndex];

          // Try multiple ways to click the button
          ['mousedown', 'mouseup', 'click'].forEach(eventType => {
            targetButton.dispatchEvent(new MouseEvent(eventType, {
              view: window,
              bubbles: true,
              cancelable: true,
              composed: true
            }));
          });

          targetButton.click();

          // If that was successful, we're done
          return true;
        }
      }
    }

    // Hard-coded indices based on logs
    let targetIndices = [];

    if (command === 'rewind') {
      targetIndices = [1, 36]; // Indices where rewind button was found
    } else if (command === 'play-pause') {
      targetIndices = [0, 35]; // Indices where play/pause button was found
    } else {
      return false;
    }

    const allButtons = document.querySelectorAll('button');

    let success = false;

    // Try clicking button at each target index
    for (const index of targetIndices) {
      if (index < allButtons.length) {
        const button = allButtons[index];

        // Try multiple click approaches
        try {
          // First, dispatch multiple types of mouse events
          ['mousedown', 'mouseup', 'click'].forEach(eventType => {
            button.dispatchEvent(new MouseEvent(eventType, {
              view: window,
              bubbles: true,
              cancelable: true,
              // Set these to ensure event propagation
              composed: true,
              detail: 1
            }));
          });

          // Then try direct click
          button.click();

          // Also try to check if there's an SVG or span inside to click
          const svgElement = button.querySelector('svg');
          if (svgElement) {
            svgElement.click();
          }

          const useElement = button.querySelector('use');
          if (useElement) {
            useElement.click();
          }

          // Also try triggering the default action
          const form = button.closest('form');
          if (form) {
            form.submit();
          }

          // If this is a rewind button, also try setting currentTime on video element
          if (command === 'rewind') {
            const video = document.querySelector('video');
            if (video) {
              // Use adjustVideoTime which now has compensation for the 3x issue
              adjustVideoTime(video, -10);
            }
          }

          success = true;
        } catch (e) {
          console.error(`Error clicking button at index ${index}:`, e);
        }
      }
    }

    // Also try to find and click buttons by their data-plyr attribute
    const dataAttr = command === 'rewind' ? 'rewind' : 'play';
    const targetButtons = document.querySelectorAll(`button[data-plyr="${dataAttr}"]`);

    if (targetButtons.length > 0) {

      for (const button of targetButtons) {
        try {
          button.click();
          success = true;
        } catch (e) {
          console.error(`Error clicking button with data-plyr="${dataAttr}":`, e);
        }
      }
    }

    return success;
  } catch (e) {
    console.error('Error in aggressive button clicking method:', e);
    return false;
  }
}

// Simple direct method to find and click the correct button
function clickVideoButton(command) {
  try {
    // Find all the buttons to ensure we don't miss any due to DOM changes
    const allButtons = document.querySelectorAll('button');

    // Based on the screenshot showing pause, -10s, +10s buttons in a row
    // First try to identify a row of three adjacent video control buttons
    const videoControlGroups = document.querySelectorAll('.ytp-left-controls, .plyr__controls, .vjs-control-bar, .mejs__controls, .video-controls, [class*="controls"]');


    // Store all potential target buttons to try
    const targetButtons = [];

    // STEP 0: Try to identify by position in a group of 3 controls
    if (videoControlGroups.length > 0) {
      for (const group of videoControlGroups) {
        const buttons = group.querySelectorAll('button');
        // If we find a group with 3 buttons next to each other, they're likely the play/rewind/forward
        if (buttons.length >= 3) {


          // Map positions based on common UI patterns (play/pause leftmost, rewind middle, forward rightmost)
          const positionMap = {
            'play-pause': 0,
            'rewind': 1,
            'fast-forward': 2
          };

          const targetPos = positionMap[command];
          if (targetPos !== undefined && targetPos < buttons.length) {

            targetButtons.push(buttons[targetPos]);
          }
        }
      }
    }

    // Map commands to button indices and data-plyr attributes
    const buttonMap = {
      'play-pause': {
        dataAttr: 'play',
        defaultIndex: 0,
        ariaLabel: ['play', 'pause', 'Play', 'Pause'],
        titleContains: ['play', 'pause', 'Play', 'Pause'],
        classContains: ['play', 'pause']
      },
      'rewind': {
        dataAttr: 'rewind',
        defaultIndex: 1,
        ariaLabel: ['rewind', 'Rewind', 'back', 'Back', 'previous', '10 seconds', '-10', '10s'],
        titleContains: ['rewind', 'back', 'previous', '10 seconds', '-10', '10s'],
        classContains: ['rewind', 'back', 'prev', 'backward']
      },
      'fast-forward': {
        dataAttr: 'fast-forward',
        defaultIndex: 2,
        ariaLabel: ['forward', 'Forward', 'next', 'Next', 'skip', '10 seconds', '+10', '10s'],
        titleContains: ['forward', 'next', 'skip', '10 seconds', '+10', '10s'],
        classContains: ['forward', 'next', 'skip']
      }
    };

    if (!buttonMap[command]) {
      console.error('Unknown command:', command);
      return false;
    }

    const { dataAttr, defaultIndex, ariaLabel, titleContains, classContains } = buttonMap[command];

    // STEP 1: Search by data attribute
    const dataAttrButtons = document.querySelectorAll(`button[data-plyr="${dataAttr}"]`);
    dataAttrButtons.forEach(btn => targetButtons.push(btn));

    // STEP 2: Search by aria-label 
    for (let i = 0; i < allButtons.length; i++) {
      const btn = allButtons[i];
      const label = btn.getAttribute('aria-label')?.toLowerCase();

      if (label && ariaLabel.some(term => label.includes(term.toLowerCase()))) {
        targetButtons.push(btn);
      }
    }

    // STEP 2.5: Search by title attribute
    for (let i = 0; i < allButtons.length; i++) {
      const btn = allButtons[i];
      const title = btn.getAttribute('title')?.toLowerCase();

      if (title && titleContains.some(term => title.includes(term.toLowerCase()))) {
        targetButtons.push(btn);
      }
    }

    // STEP 3: Try by class names
    for (let i = 0; i < allButtons.length; i++) {
      const btn = allButtons[i];
      const classNames = btn.className.toLowerCase();

      // Look for class names containing command keywords
      if (classContains.some(term => classNames.includes(term.toLowerCase()))) {
        targetButtons.push(btn);
      }
    }

    // STEP 4: Search for inner elements with descriptive text
    for (let i = 0; i < allButtons.length; i++) {
      const btn = allButtons[i];
      const innerText = btn.textContent?.toLowerCase() || '';

      // Check if button or children contain relevant text
      if (titleContains.some(term => innerText.includes(term.toLowerCase()))) {
        targetButtons.push(btn);
      }

      // Look for child elements with relevant icons or text
      const childElems = btn.querySelectorAll('*');
      for (const child of childElems) {
        const childClass = (typeof child.className === 'string') ? child.className.toLowerCase() : '';
        const childText = child.textContent?.toLowerCase() || '';

        if (
          (childClass && classContains.some(term => childClass.includes(term.toLowerCase()))) ||
          (childText && titleContains.some(term => childText.includes(term.toLowerCase())))
        ) {
          targetButtons.push(btn);
          break;
        }
      }
    }

    // STEP 5: Look for buttons with relevant SVG paths or titles that might indicate their function
    document.querySelectorAll('button svg, button img').forEach(icon => {
      const button = icon.closest('button');
      if (button) {
        // Check title attributes on the SVG or parent button
        const svgTitle = icon.querySelector('title')?.textContent?.toLowerCase() || '';

        if (titleContains.some(term => svgTitle.includes(term.toLowerCase()))) {
          targetButtons.push(button);
        }
      }
    });

    // STEP 6: As a last resort, use index-based approach
    if (allButtons.length > defaultIndex) {
      targetButtons.push(allButtons[defaultIndex]);

      // Also try index+35 (based on the pattern seen in logs)
      if (allButtons.length > defaultIndex + 35) {
        targetButtons.push(allButtons[defaultIndex + 35]);
      }
    }

    if (targetButtons.length === 0) {
      console.error(`Could not find any ${command} button`);
      return false;
    }

    // Try clicking each button until one works
    let success = false;
    for (const button of targetButtons) {
      try {
        // Try multiple click approaches
        ['mousedown', 'mouseup', 'click'].forEach(eventType => {
          button.dispatchEvent(new MouseEvent(eventType, {
            view: window,
            bubbles: true,
            cancelable: true,
            composed: true,
            detail: 1
          }));
        });

        button.click();

        // Try clicking inner elements as well
        const innerElements = button.querySelectorAll('*');
        for (const elem of innerElements) {
          try {
            elem.click();
          } catch (e) {
            // Ignore errors on inner elements
          }
        }

        success = true;
      } catch (e) {
        console.error(`Error clicking button:`, e);
      }
    }

    return success;
  } catch (e) {
    console.error('Error in clickVideoButton method:', e);
    return false;
  }
}

// Method for simulating keyboard events
function tryKeyboardMethod(command) {
  try {
    // Map commands to keyboard keys (key, keyCode, and alternative keys)
    const keyMap = {
      'fast-forward': { main: ['ArrowRight', 39], alt: ['L', 76, 'l'] },
      'rewind': { main: ['ArrowLeft', 37], alt: ['J', 74, 'j'] },
      'play-pause': { main: [' ', 32], alt: ['K', 75, 'k'] }  // Space key, and K as alternative
    };

    if (!keyMap[command]) {
      return false;
    }

    // Find the video player element to focus
    const videoElements = document.querySelectorAll('video');
    const videoControlsElements = document.querySelectorAll('.plyr__controls, .ytp-chrome-controls, .vjs-control-bar');
    const playerElements = document.querySelectorAll('.plyr, .html5-video-player, .video-js');

    // Try to focus the video or control element first
    let targetElement = document;
    let focused = false;

    // Try focusing different elements in order of specificity
    if (videoElements.length > 0) {
      targetElement = videoElements[0];
      videoElements[0].focus();
      focused = true;
    }

    if (!focused && playerElements.length > 0) {
      targetElement = playerElements[0];
      playerElements[0].focus();
      focused = true;
    }

    if (!focused && videoControlsElements.length > 0) {
      targetElement = videoControlsElements[0];
      videoControlsElements[0].focus();
      focused = true;
    }

    // Helper to create keyboard events
    function createKeyboardEvent(type, key, keyCode) {
      return new KeyboardEvent(type, {
        key: key,
        code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`,
        keyCode: keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        view: window,
        composed: true
      });
    }

    // Try all possible keyboard shortcuts for this command
    let success = false;

    // First try the main key
    const { main, alt } = keyMap[command];
    const [mainKey, mainKeyCode] = main;

    // Create keydown and keyup events
    const keyDownEvent = createKeyboardEvent('keydown', mainKey, mainKeyCode);
    const keyUpEvent = createKeyboardEvent('keyup', mainKey, mainKeyCode);

    // Dispatch on both the target element and document
    targetElement.dispatchEvent(keyDownEvent);
    document.dispatchEvent(keyDownEvent);

    // Short delay between keydown and keyup
    setTimeout(() => {
      targetElement.dispatchEvent(keyUpEvent);
      document.dispatchEvent(keyUpEvent);

      // Now try alternative keys if available
      if (alt) {
        const [altKey, altKeyCode, altKeyLower] = alt;

        // Create alternative keydown and keyup events
        const altKeyDownEvent = createKeyboardEvent('keydown', altKey, altKeyCode);
        const altKeyUpEvent = createKeyboardEvent('keyup', altKey, altKeyCode);

        // Dispatch alternative keys
        targetElement.dispatchEvent(altKeyDownEvent);
        document.dispatchEvent(altKeyDownEvent);

        setTimeout(() => {
          targetElement.dispatchEvent(altKeyUpEvent);
          document.dispatchEvent(altKeyUpEvent);

          // Also try lowercase version if it's a letter
          if (altKeyLower) {
            const lowerKeyDownEvent = createKeyboardEvent('keydown', altKeyLower, altKeyCode);
            const lowerKeyUpEvent = createKeyboardEvent('keyup', altKeyLower, altKeyCode);

            targetElement.dispatchEvent(lowerKeyDownEvent);
            document.dispatchEvent(lowerKeyDownEvent);

            setTimeout(() => {
              targetElement.dispatchEvent(lowerKeyUpEvent);
              document.dispatchEvent(lowerKeyUpEvent);
            }, 50);
          }
        }, 50);
      }
    }, 50);

    return true;
  } catch (e) {
    console.error('Error in keyboard method:', e);
    return false;
  }
}

// Add a safer method for fast-forward to avoid navigation
function tryFastForwardSafely() {
  try {
    // Find fast-forward buttons while strictly avoiding navigation buttons
    const validButtons = [];

    // Direct data-plyr selectors (safest)
    const plyrButtons = document.querySelectorAll('button[data-plyr="fast-forward"]');
    if (plyrButtons.length > 0) {
      validButtons.push(...Array.from(plyrButtons));
    }

    // Look for SVG use with fast-forward reference
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      const svgUse = btn.querySelector('svg use');
      if (svgUse) {
        // Check both href and xlink:href attributes
        const href = svgUse.getAttribute('href') || svgUse.getAttribute('xlink:href') || "";
        if (href === '#plyr-fast-forward') {
          // Check if it's not already in our list
          if (!validButtons.includes(btn)) {
            validButtons.push(btn);
          }
        }
      }

      // Check for text "Forward 10s" exactly
      const span = btn.querySelector('.plyr__sr-only, .sr-only');
      if (span && span.textContent.trim() === 'Forward 10s') {
        if (!validButtons.includes(btn)) {
          validButtons.push(btn);
        }
      }
    }

    if (validButtons.length > 0) {

      for (const btn of validButtons) {
        btn.click();
        return true;
      }
    }

    return false;
  } catch (e) {
    console.error('Error in safe fast-forward method:', e);
    return false;
  }
}

// Special fallback methods for problematic commands
function tryRewindFallback() {
  try {
    // Try direct approach first (which we may have already tried, but double-check)
    const directButton = findExactButton('rewind');
    if (directButton) {
      return tryButtonClick(directButton);
    }

    // Find rewind buttons while strictly avoiding navigation buttons
    const validButtons = [];

    // Direct data-plyr selectors (safest)
    const plyrButtons = document.querySelectorAll('button[data-plyr="rewind"]');
    if (plyrButtons.length > 0) {
      validButtons.push(...Array.from(plyrButtons));
    }

    // Look for SVG use with rewind reference
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      // Skip any non-player buttons
      if (
        btn.classList.contains('mr-5') || // Notification button class
        btn.getAttribute('aria-haspopup') === 'dialog' || // Dialog trigger buttons
        btn.parentElement?.getAttribute('aria-haspopup') === 'dialog' || // Dialog parent buttons
        (btn.textContent?.includes('Search')) // Search buttons
      ) {
        continue;
      }

      const svgUse = btn.querySelector('svg use');
      if (svgUse) {
        // Check both href and xlink:href attributes
        const href = svgUse.getAttribute('href') || svgUse.getAttribute('xlink:href') || "";
        if (href === '#plyr-rewind') {
          // Check if it's not already in our list
          if (!validButtons.includes(btn)) {
            validButtons.push(btn);
          }
        }
      }

      // Check for text "Rewind 10s" exactly
      const span = btn.querySelector('.plyr__sr-only, .sr-only');
      if (span && span.textContent.trim() === 'Rewind 10s') {
        if (!validButtons.includes(btn)) {
          validButtons.push(btn);
        }
      }
    }

    if (validButtons.length > 0) {

      for (const btn of validButtons) {
        if (tryButtonClick(btn)) {
          return true;
        }
      }
    }

    // Try to find a video element directly and rewind it
    const videos = document.querySelectorAll('video');
    if (videos.length > 0) {
      const video = videos[0];

      // Try using our precision function
      if (adjustVideoTime(video, -10)) {
        return true;
      }
    }

    return false;
  } catch (e) {
    console.error('Error in rewind fallback method:', e);
    return false;
  }
}

function tryPlayPauseFallback() {
  try {

    // Find only the plyr play button and try to click it first - this is the most reliable
    const plyrButton = document.querySelector('button[data-plyr="play"]');
    if (plyrButton) {
      plyrButton.click();
      return true;
    }

    // Next most reliable - find buttons with plyr svg references
    const allButtons = document.querySelectorAll('button');
    const playPauseButtons = Array.from(allButtons).filter(btn => {
      const svgUse = btn.querySelector('svg use');
      if (!svgUse) return false;

      const href = svgUse.getAttribute('href') || svgUse.getAttribute('xlink:href') || "";
      return href === '#plyr-play' || href === '#plyr-pause';
    });

    if (playPauseButtons.length > 0) {
      playPauseButtons[0].click();
      return true;
    }

    // Try direct video approach - third most reliable
    const videos = document.querySelectorAll('video');
    if (videos.length > 0) {
      const video = videos[0];

      // Toggle play state
      if (video.paused) {
        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
          }).catch(error => {
            console.error('Error playing video:', error);
          });
        }
      } else {
        video.pause();
      }
      return true;
    }

    // Only try keyboard as an absolute last resort, with better focus handling

    // Try focused element approach first
    const activeElement = document.activeElement;
    if (activeElement && activeElement.tagName !== 'INPUT' && activeElement.tagName !== 'TEXTAREA') {
      // Send space key to the active element if it's not a text field
      const spaceEvent = new KeyboardEvent('keydown', {
        key: ' ',
        code: 'Space',
        keyCode: 32,
        which: 32,
        bubbles: false,
        cancelable: true
      });

      activeElement.dispatchEvent(spaceEvent);

      setTimeout(() => {
        const spaceUpEvent = new KeyboardEvent('keyup', {
          key: ' ',
          code: 'Space',
          keyCode: 32,
          which: 32,
          bubbles: false,
          cancelable: true
        });

        activeElement.dispatchEvent(spaceUpEvent);
      }, 50);

      return true;
    }

    // Last resort - try K key
    const kKeyDown = new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      keyCode: 75,
      which: 75,
      bubbles: false,
      cancelable: true
    });

    const kKeyUp = new KeyboardEvent('keyup', {
      key: 'k',
      code: 'KeyK',
      keyCode: 75,
      which: 75,
      bubbles: false,
      cancelable: true
    });

    document.dispatchEvent(kKeyDown);
    setTimeout(() => {
      document.dispatchEvent(kKeyUp);
    }, 50);

    return true;
  } catch (e) {
    console.error('Error in play/pause fallback method:', e);
    return false;
  }
}

// Function to try a direct click on a button, simulating it with multiple methods
function tryButtonClick(button) {
  if (!button) return false;

  try {

    // First try the most direct method - focus and click
    button.focus();

    // Try mousedown/mouseup for player UIs that need these events
    button.dispatchEvent(new MouseEvent('mousedown', {
      view: window,
      bubbles: true,
      cancelable: true,
      composed: true
    }));

    button.dispatchEvent(new MouseEvent('mouseup', {
      view: window,
      bubbles: true,
      cancelable: true,
      composed: true
    }));

    // Then perform the direct click
    button.click();

    // Also try clicking any SVG inside if present (some players listen to these)
    const svg = button.querySelector('svg');
    if (svg) {
      try {
        // Some SVG elements might not have a click method
        if (typeof svg.click === 'function') {
          svg.click();
        } else {
          // Trigger a click event on the SVG instead
          svg.dispatchEvent(new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true,
            composed: true
          }));
        }
      } catch (e) {
      }
    }

    // For play buttons, try setting aria-pressed attribute directly
    // This can sometimes trigger UI updates when click events don't work
    if (button.getAttribute('data-plyr') === 'play') {
      const isPressed = button.getAttribute('aria-pressed') === 'true';
      button.setAttribute('aria-pressed', !isPressed);

      // Add/remove the pressed class which some players use
      if (isPressed) {
        button.classList.remove('plyr__control--pressed');
      } else {
        button.classList.add('plyr__control--pressed');
      }
    }


    return true;
  } catch (e) {
    console.error('Error clicking button:', e);
    return false;
  }
}

// Try to find a specific button with exact matches
function findExactButton(command) {
  // Look specifically for buttons with data-plyr attribute
  const dataPlyrValue = {
    'play-pause': 'play',
    'rewind': 'rewind',
    'fast-forward': 'fast-forward'
  }[command];

  if (!dataPlyrValue) return null;

  // First, direct data-plyr attribute match (most reliable for Plyr)
  const plyrButton = document.querySelector(`button[data-plyr="${dataPlyrValue}"]`);
  if (plyrButton) {
    return plyrButton;
  }

  // Second, try to find by SVG use href
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    const svgUse = btn.querySelector('svg use');
    if (svgUse) {
      const href = svgUse.getAttribute('href') || svgUse.getAttribute('xlink:href') || "";
      if (href === `#plyr-${dataPlyrValue}`) {

        return btn;
      }
    }

    // Try to match by span content
    const span = btn.querySelector('.plyr__sr-only');
    if (span) {
      const textContent = span.textContent.trim();
      if ((command === 'rewind' && textContent === 'Rewind 10s') ||
        (command === 'fast-forward' && textContent === 'Forward 10s') ||
        (command === 'play-pause' && (textContent === 'Play' || textContent === 'Pause'))) {

        return btn;
      }
    }
  }

  return null;
}

// Track last time adjustment to prevent duplicates
let lastTimeAdjustment = 0;

// Helper function that simulates a SINGLE arrow key press
function adjustVideoTime(video, adjustmentSeconds) {
  // Instead of trying to adjust time directly, let's simulate a single key press event
  try {
    // Prevent multiple rapid adjustments
    const now = Date.now();
    if (now - lastTimeAdjustment < 400) {
      return true; // Return true to prevent fallback methods
    }

    // Record this adjustment time
    lastTimeAdjustment = now;

    // Determine which key to press based on direction
    const key = adjustmentSeconds > 0 ? 'ArrowRight' : 'ArrowLeft';
    const keyCode = adjustmentSeconds > 0 ? 39 : 37;

    // Create and dispatch a SINGLE keydown event
    const keyDownEvent = new KeyboardEvent('keydown', {
      key: key,
      code: adjustmentSeconds > 0 ? 'ArrowRight' : 'ArrowLeft',
      keyCode: keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      view: window
    });

    // We'll focus the video element first if possible
    if (video) {
      video.focus();
    }

    // Send event to document (this is what most players detect)
    document.dispatchEvent(keyDownEvent);

    // Follow up with a keyup after a short delay
    setTimeout(() => {
      const keyUpEvent = new KeyboardEvent('keyup', {
        key: key,
        code: adjustmentSeconds > 0 ? 'ArrowRight' : 'ArrowLeft',
        keyCode: keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        view: window
      });

      document.dispatchEvent(keyUpEvent);
    }, 50);

    return true;
  } catch (e) {
    console.error('Error simulating key press:', e);
    return false;
  }
}

// Specialized function to ONLY find and click the forward button
function clickOnlyForwardButton() {
  try {
    // Try finding buttons with the most common attributes for forward buttons
    const possibleButtons = [];

    // Try by aria-label (most reliable)
    document.querySelectorAll('[aria-label*="forward"], [aria-label*="Forward"], [aria-label*="10s"], [aria-label*="+10"]').forEach(el => {
      if (el.tagName === 'BUTTON' || el.role === 'button') {
        possibleButtons.push(el);
      }
    });

    // Try by title
    document.querySelectorAll('[title*="forward"], [title*="Forward"], [title*="10s"], [title*="+10"]').forEach(el => {
      if (el.tagName === 'BUTTON' || el.role === 'button') {
        possibleButtons.push(el);
      }
    });

    // Try by data attribute
    document.querySelectorAll('[data-plyr="fast-forward"]').forEach(el => {
      possibleButtons.push(el);
    });

    // Try by class
    document.querySelectorAll('.plyr__controls__item--forward, .vjs-skip-forward-button, .forward-button, [class*="forward"]').forEach(el => {
      if (el.tagName === 'BUTTON' || el.role === 'button') {
        possibleButtons.push(el);
      }
    });

    // Try by inner text/content
    document.querySelectorAll('button').forEach(btn => {
      const text = btn.textContent?.toLowerCase() || '';
      const innerHtml = btn.innerHTML.toLowerCase();
      if (text.includes('forward') || text.includes('+10') || innerHtml.includes('forward') || innerHtml.includes('+10')) {
        possibleButtons.push(btn);
      }
    });

    // Try SVG paths inside buttons
    document.querySelectorAll('button svg').forEach(svg => {
      const button = svg.closest('button');
      if (button) {
        // Get any title inside the SVG
        const title = svg.querySelector('title');
        if (title && (title.textContent.includes('forward') || title.textContent.includes('Forward'))) {
          possibleButtons.push(button);
        }

        // Check SVG use elements
        const use = svg.querySelector('use');
        if (use) {
          const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
          if (href.includes('forward') || href.includes('fast-forward')) {
            possibleButtons.push(button);
          }
        }
      }
    });

    // Deduplicate buttons
    const uniqueButtons = Array.from(new Set(possibleButtons));

    if (uniqueButtons.length > 0) {
      // Try each button until one works
      for (const button of uniqueButtons) {
        try {
          // Try multiple click events to ensure it triggers
          button.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window
          }));

          button.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            view: window
          }));

          button.click();
          return true;
        } catch (e) {
          // Continue to the next button
        }
      }
    }

    // If we couldn't find any buttons, fall back to keyboard
    return adjustVideoTime(null, 10);
  } catch (e) {
    console.error('Error in clickOnlyForwardButton:', e);
    return false;
  }
}

// Specialized function to ONLY find and click rewind button
function clickOnlyRewindButton() {
  try {
    // Try finding buttons with the most common attributes for rewind buttons
    const possibleButtons = [];

    // Try by aria-label (most reliable)
    document.querySelectorAll('[aria-label*="rewind"], [aria-label*="Rewind"], [aria-label*="back"], [aria-label*="Back"], [aria-label*="-10"], [aria-label*="previous"], [aria-label*="Previous"]').forEach(el => {
      if (el.tagName === 'BUTTON' || el.role === 'button') {
        possibleButtons.push(el);
      }
    });

    // Try by title
    document.querySelectorAll('[title*="rewind"], [title*="Rewind"], [title*="back"], [title*="Back"], [title*="-10"], [title*="previous"], [title*="Previous"]').forEach(el => {
      if (el.tagName === 'BUTTON' || el.role === 'button') {
        possibleButtons.push(el);
      }
    });

    // Try by data attribute
    document.querySelectorAll('[data-plyr="rewind"]').forEach(el => {
      possibleButtons.push(el);
    });

    // Try by class
    document.querySelectorAll('.plyr__controls__item--rewind, .vjs-skip-backward-button, .backward-button, .rewind-button, [class*="rewind"], [class*="back"]').forEach(el => {
      if (el.tagName === 'BUTTON' || el.role === 'button') {
        possibleButtons.push(el);
      }
    });

    // Try by inner text/content
    document.querySelectorAll('button').forEach(btn => {
      const text = btn.textContent?.toLowerCase() || '';
      const innerHtml = btn.innerHTML.toLowerCase();
      if (text.includes('rewind') || text.includes('back') || text.includes('-10') ||
        innerHtml.includes('rewind') || innerHtml.includes('back') || innerHtml.includes('-10')) {
        possibleButtons.push(btn);
      }
    });

    // Try SVG paths inside buttons
    document.querySelectorAll('button svg').forEach(svg => {
      const button = svg.closest('button');
      if (button) {
        // Get any title inside the SVG
        const title = svg.querySelector('title');
        if (title && (title.textContent.includes('rewind') || title.textContent.includes('Rewind') ||
          title.textContent.includes('back') || title.textContent.includes('Back'))) {
          possibleButtons.push(button);
        }

        // Check SVG use elements
        const use = svg.querySelector('use');
        if (use) {
          const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
          if (href.includes('rewind') || href.includes('back')) {
            possibleButtons.push(button);
          }
        }
      }
    });

    // Deduplicate buttons
    const uniqueButtons = Array.from(new Set(possibleButtons));

    if (uniqueButtons.length > 0) {
      // Try each button until one works
      for (const button of uniqueButtons) {
        try {
          // Try multiple click events to ensure it triggers
          button.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window
          }));

          button.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            view: window
          }));

          button.click();
          return true;
        } catch (e) {
          // Continue to the next button
        }
      }
    }

    // If we couldn't find any buttons, fall back to keyboard
    return adjustVideoTime(null, -10);
  } catch (e) {
    console.error('Error in clickOnlyRewindButton:', e);
    return false;
  }
} 