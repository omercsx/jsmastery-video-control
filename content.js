// This script runs directly in the context of the web page

// Add console logging to confirm content script is running
console.log('Video Control Extension content script loaded');

// Keep track of whether we're in the main script instance
let isMainScriptInstance = true;

// Use a command processing lock to prevent multiple instances from processing the same command
let isProcessingCommand = false;

// Global command lock using localStorage
const COMMAND_LOCK_KEY = 'jsmastery_videocontrol_command_lock';
const COMMAND_LOCK_EXPIRY = 'jsmastery_videocontrol_lock_expiry';

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
  console.log('Message received in content script:', message);

  // Respond to ping to confirm content script is running
  if (message.action === 'ping') {
    console.log('Ping received, responding to confirm content script is running');
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'controlVideo') {
    // If another instance is already processing a command, ignore this one
    if (isProcessingCommand) {
      console.log('This instance is already processing a command, ignoring this one');
      sendResponse({ success: false, reason: 'duplicate-instance' });
      return true;
    }

    // Try to acquire the global command lock
    if (!acquireCommandLock()) {
      console.log('Another instance has the command lock, ignoring this request');
      sendResponse({ success: false, reason: 'locked' });
      return true;
    }

    // Set processing lock to prevent multiple instances from handling the same command
    isProcessingCommand = true;

    const command = message.command;

    // Prevent any default actions from the website when our commands run
    const preventHandler = (e) => preventDefaultOnce(e);
    document.addEventListener('keydown', preventHandler, true);
    document.addEventListener('keyup', preventHandler, true);

    const success = performVideoControl(command);
    console.log('Command execution result:', success);

    // Release the processing lock
    isProcessingCommand = false;

    // Release global lock
    releaseCommandLock();

    sendResponse({ success: success });

    // If this instance failed but got a response, mark as secondary
    if (!success) {
      isMainScriptInstance = false;
    }

    // Clean up event listeners after a short delay
    setTimeout(() => {
      document.removeEventListener('keydown', preventHandler, true);
      document.removeEventListener('keyup', preventHandler, true);
    }, 200);
  }
  return true; // Keep the message channel open for asynchronous response
});

// Function to control video based on commands
function performVideoControl(command) {
  console.log('Attempting to perform video control:', command);

  // First try the direct button approach (most reliable for Plyr)
  const exactButton = findExactButton(command);
  if (exactButton) {
    console.log(`Found exact button for ${command}, trying direct click`);
    const clickResult = tryButtonClick(exactButton);
    if (clickResult) {
      console.log('Direct button click succeeded!');
      return true; // Exit immediately on success
    }
  }

  // If direct button approach fails, continue with pattern matching
  const playerPatterns = trySpecificPlayerPatterns();
  if (playerPatterns.length > 0) {
    console.log('Found specific player control pattern(s), trying targeted approach first');
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
          console.log("Avoiding non-video control button:", btn.outerHTML);
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
            console.log("Avoiding rewind button for fast-forward:", btn.outerHTML);
            isMatch = false;
          }
        }

        console.log(`Button candidate for ${command}:`, btn.outerHTML,
          {
            btnDataPlyr,
            ariaLabel,
            title,
            innerText,
            svgUseHref,
            isMatch
          }
        );

        if (isMatch) {
          foundButton = btn;
          break;
        }
      }

      if (foundButton) {
        console.log(`Clicking button for '${command}' from identified control group:`, foundButton.outerHTML);
        try {
          // Use our new tryButtonClick method for more reliable clicking
          const success = tryButtonClick(foundButton);
          if (success) {
            console.log('Specific player control group approach succeeded!');
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
    console.log('HTML5 video method succeeded!');
    return true;
  }

  // Final fallbacks if nothing else worked
  if (command === 'rewind') {
    const rewindResult = tryRewindFallback();
    if (rewindResult) {
      console.log('Rewind fallback succeeded!');
      return true;
    }
  } else if (command === 'play-pause') {
    const playPauseResult = tryPlayPauseFallback();
    if (playPauseResult) {
      console.log('Play/pause fallback succeeded!');
      return true;
    }
  } else if (command === 'fast-forward') {
    const fastForwardResult = tryFastForwardSafely();
    if (fastForwardResult) {
      console.log('Safe fast-forward method succeeded!');
      return true;
    }
  }

  // If all else fails, try keyboard events as a last resort
  const keyboardResult = tryKeyboardMethod(command);
  if (keyboardResult) {
    console.log('Keyboard events method succeeded!');
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
      console.log('Looking for HTML5 video elements...');

      // Find all video elements on the page
      let videos = document.querySelectorAll('video');
      console.log(`Found ${videos.length} direct video elements`);

      // If no videos found directly, try finding in iframes
      if (videos.length === 0) {
        try {
          // Try to access videos in all iframes
          const iframes = document.querySelectorAll('iframe');
          console.log(`Checking ${iframes.length} iframes for videos`);

          for (const iframe of iframes) {
            try {
              if (iframe.contentDocument && iframe.contentDocument.querySelectorAll) {
                const iframeVideos = iframe.contentDocument.querySelectorAll('video');
                if (iframeVideos.length > 0) {
                  console.log(`Found ${iframeVideos.length} videos in iframe`);
                  videos = iframeVideos;
                  break;
                }
              }
            } catch (frameError) {
              // Cross-origin iframe access might fail - this is expected for many iframes
              console.log('Could not access iframe content (likely cross-origin)');
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
        console.log('Caching video element for future use:', cachedVideoElement);
      } else {
        return false; // No videos found
      }
    }

    // Use the cached video element
    const video = cachedVideoElement;

    switch (command) {
      case 'fast-forward':
        // Fast forward by 10 seconds
        const originalTime = video.currentTime;
        video.currentTime += 10;
        console.log(`Fast-forwarding video by 10 seconds (from ${originalTime} to ${video.currentTime})`);
        return Math.abs(video.currentTime - originalTime) > 1; // Return true only if it actually moved
      case 'rewind':
        // Rewind by 10 seconds
        const startTime = video.currentTime;
        video.currentTime -= 10;
        console.log(`Rewinding video by 10 seconds (from ${startTime} to ${video.currentTime})`);
        return Math.abs(video.currentTime - startTime) > 1; // Return true only if it actually moved
      case 'play-pause':
        // Toggle play/pause
        if (video.paused) {
          const playPromise = video.play();
          // Handle the play promise to avoid uncaught promise errors
          if (playPromise !== undefined) {
            playPromise
              .then(() => console.log('Playing video (HTML5 method)'))
              .catch(error => {
                console.error('Error playing video:', error);
                return false;
              });
          }
        } else {
          video.pause();
          console.log('Pausing video (HTML5 method)');
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
  console.log('Trying to detect specific player control patterns/groups');
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
      console.log(`Found ${controlGroupsOnPage.length} potential groups with selector '${selector}'`);
    }
    for (const group of controlGroupsOnPage) {
      // Check if this group element has already been added to playerPatterns by a more specific selector
      let alreadyProcessed = playerPatterns.some(p => p.element === group);
      if (alreadyProcessed) {
        console.log('Skipping already processed group:', group);
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

  console.log(`Found ${uniquePatterns.length} unique potential player control pattern(s)/group(s)`);
  return uniquePatterns;
}

// Aggressive method to try multiple ways to click the buttons
function clickVideoButtonAggressively(command) {
  try {
    // First try the specific player patterns based on the screenshot
    const playerPatterns = trySpecificPlayerPatterns();
    if (playerPatterns.length > 0) {
      console.log('Trying specific player control patterns first');

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
          console.log(`Clicking button ${targetIndex} from pattern:`, targetButton.outerHTML);

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
    console.log(`Found ${allButtons.length} total buttons for aggressive clicking`);

    let success = false;

    // Try clicking button at each target index
    for (const index of targetIndices) {
      if (index < allButtons.length) {
        const button = allButtons[index];
        console.log(`Aggressively clicking button at index ${index}:`, button.outerHTML);

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
            console.log('Clicking inner SVG element');
            svgElement.click();
          }

          const useElement = button.querySelector('use');
          if (useElement) {
            console.log('Clicking inner use element');
            useElement.click();
          }

          // Also try triggering the default action
          const form = button.closest('form');
          if (form) {
            console.log('Submitting containing form');
            form.submit();
          }

          // If this is a rewind button, also try setting currentTime on video element
          if (command === 'rewind') {
            const video = document.querySelector('video');
            if (video) {
              console.log('Also rewinding video directly');
              video.currentTime -= 10;
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
      console.log(`Found ${targetButtons.length} buttons with data-plyr="${dataAttr}"`);

      for (const button of targetButtons) {
        try {
          console.log(`Clicking button with data-plyr="${dataAttr}":`, button.outerHTML);
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
    console.log(`Found ${allButtons.length} total buttons`);

    // Based on the screenshot showing pause, -10s, +10s buttons in a row
    // First try to identify a row of three adjacent video control buttons
    const videoControlGroups = document.querySelectorAll('.ytp-left-controls, .plyr__controls, .vjs-control-bar, .mejs__controls, .video-controls, [class*="controls"]');
    console.log(`Found ${videoControlGroups.length} potential control groups`);

    // Store all potential target buttons to try
    const targetButtons = [];

    // STEP 0: Try to identify by position in a group of 3 controls
    if (videoControlGroups.length > 0) {
      for (const group of videoControlGroups) {
        const buttons = group.querySelectorAll('button');
        // If we find a group with 3 buttons next to each other, they're likely the play/rewind/forward
        if (buttons.length >= 3) {
          console.log('Found a group with 3+ control buttons');

          // Map positions based on common UI patterns (play/pause leftmost, rewind middle, forward rightmost)
          const positionMap = {
            'play-pause': 0,
            'rewind': 1,
            'fast-forward': 2
          };

          const targetPos = positionMap[command];
          if (targetPos !== undefined && targetPos < buttons.length) {
            console.log(`Adding position-based button at index ${targetPos}`);
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

    console.log(`Found ${targetButtons.length} potential ${command} buttons to try`);

    if (targetButtons.length === 0) {
      console.error(`Could not find any ${command} button`);
      return false;
    }

    // Try clicking each button until one works
    let success = false;
    for (const button of targetButtons) {
      try {
        console.log(`Trying to click ${command} button:`, button.outerHTML);

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
      console.log('Focusing video element before key press');
      videoElements[0].focus();
      focused = true;
    }

    if (!focused && playerElements.length > 0) {
      targetElement = playerElements[0];
      console.log('Focusing player element before key press');
      playerElements[0].focus();
      focused = true;
    }

    if (!focused && videoControlsElements.length > 0) {
      targetElement = videoControlsElements[0];
      console.log('Focusing video controls before key press');
      videoControlsElements[0].focus();
      focused = true;
    }

    if (!focused) {
      console.log('No specific element found to focus, using document for key events');
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

    console.log(`Trying main keyboard shortcut: ${mainKey} for ${command}`);

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

        console.log(`Trying alternative keyboard shortcut: ${altKey} for ${command}`);

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
            console.log(`Trying lowercase keyboard shortcut: ${altKeyLower} for ${command}`);

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

    console.log(`Simulated keyboard shortcuts for ${command}`);
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
      console.log(`Found ${plyrButtons.length} buttons with data-plyr="fast-forward"`);
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
      console.log(`Found ${validButtons.length} safe fast-forward buttons to try`);

      for (const btn of validButtons) {
        console.log('Trying safe fast-forward button:', btn.outerHTML);
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
      console.log(`Found ${plyrButtons.length} buttons with data-plyr="rewind"`);
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
      console.log(`Found ${validButtons.length} safe rewind buttons to try`);

      for (const btn of validButtons) {
        console.log('Trying safe rewind button:', btn.outerHTML);
        if (tryButtonClick(btn)) {
          return true;
        }
      }
    }

    // Try to find a video element directly and rewind it
    const videos = document.querySelectorAll('video');
    if (videos.length > 0) {
      console.log('Attempting direct rewind on video element');
      const video = videos[0];
      const originalTime = video.currentTime;

      // Try different approaches to rewind
      video.currentTime -= 10;

      // Check if we actually moved 
      if (Math.abs(video.currentTime - originalTime) > 1) {
        console.log('Direct video rewind succeeded');
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
    // Try direct approach first (which we may have already tried, but double-check)
    const directButton = findExactButton('play-pause');
    if (directButton) {
      const result = tryButtonClick(directButton);
      if (result) {
        console.log('Direct button click in fallback succeeded');
        return true;
      }
    }

    // Find play/pause buttons while strictly avoiding navigation buttons
    const validButtons = [];

    // Direct data-plyr selectors (safest)
    const plyrButtons = document.querySelectorAll('button[data-plyr="play"]');
    if (plyrButtons.length > 0) {
      console.log(`Found ${plyrButtons.length} buttons with data-plyr="play"`);
      validButtons.push(...Array.from(plyrButtons));
    }

    // Look for SVG use with play/pause reference
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      // Skip any buttons that are definitely not player controls
      if (
        btn.getAttribute('type') === 'submit' || // Submit buttons
        btn.getAttribute('aria-haspopup') === 'dialog' || // Dialog trigger buttons
        btn.parentElement?.getAttribute('aria-haspopup') === 'dialog' || // Dialog parent buttons
        (btn.textContent?.includes('Search')) || // Search buttons
        btn.className.includes('rounded-lg bg-dark-400') || // Search bar button
        btn.className.includes('mr-5') || // Notification button
        btn.getAttribute('aria-controls')?.includes('search') // Search controls
      ) {
        continue;
      }

      const svgUse = btn.querySelector('svg use');
      if (svgUse) {
        // Check both href and xlink:href attributes
        const href = svgUse.getAttribute('href') || svgUse.getAttribute('xlink:href') || "";
        if (href === '#plyr-play' || href === '#plyr-pause') {
          // Check if it's not already in our list
          if (!validButtons.includes(btn)) {
            validButtons.push(btn);
          }
        }
      }

      // Check for play/pause text exactly
      const span = btn.querySelector('.plyr__sr-only, .sr-only');
      if (span) {
        const text = span.textContent.trim();
        if (text === 'Play' || text === 'Pause') {
          if (!validButtons.includes(btn)) {
            validButtons.push(btn);
          }
        }
      }
    }

    if (validButtons.length > 0) {
      console.log(`Found ${validButtons.length} safe play/pause buttons to try`);

      for (const btn of validButtons) {
        console.log('Trying safe play/pause button:', btn.outerHTML);
        if (tryButtonClick(btn)) {
          return true;
        }
      }
    }

    // Try to find a video element directly and play/pause it
    const videos = document.querySelectorAll('video');
    if (videos.length > 0) {
      console.log('Attempting direct play/pause on video element');
      const video = videos[0];

      // Toggle play state
      if (video.paused) {
        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
            console.log('Direct video play succeeded');
          }).catch(error => {
            console.error('Error playing video:', error);
          });
        }
      } else {
        video.pause();
        console.log('Direct video pause succeeded');
      }
      return true;
    }

    // Only perform keyboard events if we've found no other way
    console.log('Trying keyboard method as last resort for play/pause');

    // Focus on document body to avoid text fields
    document.body.focus();

    const spaceKeyDown = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      keyCode: 32,
      which: 32,
      bubbles: false, // Set to false to avoid triggering website handlers
      cancelable: true
    });

    const spaceKeyUp = new KeyboardEvent('keyup', {
      key: ' ',
      code: 'Space',
      keyCode: 32,
      which: 32,
      bubbles: false, // Set to false to avoid triggering website handlers
      cancelable: true
    });

    document.dispatchEvent(spaceKeyDown);
    setTimeout(() => {
      document.dispatchEvent(spaceKeyUp);
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
    // First try direct click (simplest approach)
    button.click();

    // Then try a more controlled approach with events
    const clickEvent = new MouseEvent('click', {
      view: window,
      bubbles: false,  // Set to false to avoid triggering website handlers
      cancelable: true,
      composed: true
    });

    button.dispatchEvent(clickEvent);

    // Log success
    console.log('Successfully clicked button:', button.outerHTML);
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
    console.log(`Found direct Plyr button for ${command}:`, plyrButton.outerHTML);
    return plyrButton;
  }

  // Second, try to find by SVG use href
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    const svgUse = btn.querySelector('svg use');
    if (svgUse) {
      const href = svgUse.getAttribute('href') || svgUse.getAttribute('xlink:href') || "";
      if (href === `#plyr-${dataPlyrValue}`) {
        console.log(`Found button with SVG use href for ${command}:`, btn.outerHTML);
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
        console.log(`Found button with span content for ${command}:`, btn.outerHTML);
        return btn;
      }
    }
  }

  return null;
} 