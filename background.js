// Add a flag to track if a command is currently being processed
let isProcessingCommand = false;

// Add a debounce timer
let commandDebounceTimer = null;

// Last command timestamp to track and prevent duplicate executions
let lastCommandTimestamp = 0;

// Listen for keyboard commands
chrome.commands.onCommand.addListener((command) => {
  // Strong protection against multiple rapid executions
  const now = Date.now();

  // If another command was executed in the last 500ms, ignore this one completely
  if (now - lastCommandTimestamp < 500) {
    console.log('Command blocked - too soon after previous command');
    return;
  }

  // Record this command's timestamp
  lastCommandTimestamp = now;

  // Additional protection for commands in process
  if (isProcessingCommand) {
    console.log('Command blocked - previous command still processing');
    return;
  }

  // Clear any existing debounce timer
  if (commandDebounceTimer) {
    clearTimeout(commandDebounceTimer);
  }

  // Set a debounce timer to prevent multiple rapid keypresses
  commandDebounceTimer = setTimeout(() => {
    commandDebounceTimer = null;
  }, 500); // Increased from 300 to 500ms

  isProcessingCommand = true;

  // Get the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      const activeTab = tabs[0];

      // First try to send a message to see if content script is already running
      try {
        chrome.tabs.sendMessage(
          activeTab.id,
          { action: 'ping' },
          function (response) {
            if (chrome.runtime.lastError || !response) {
              injectContentScriptAndSendCommand(activeTab.id, command);
            } else {
              sendCommandToContentScript(activeTab.id, command);
            }
          }
        );
      } catch (error) {
        injectContentScriptAndSendCommand(activeTab.id, command);

        // Release the command processing lock after a delay
        setTimeout(() => {
          isProcessingCommand = false;
        }, 500);
      }
    } else {
      isProcessingCommand = false;
    }
  });
});

// Function to inject content script and then send command
function injectContentScriptAndSendCommand(tabId, command) {
  chrome.scripting.executeScript({
    target: { tabId: tabId, allFrames: true },
    files: ['content.js']
  })
    .then(() => {
      // Wait a moment to make sure the content script is fully loaded
      setTimeout(() => {
        sendCommandToContentScript(tabId, command);
      }, 200); // Increased from 100 to 200 for more reliable loading
    })
    .catch(error => {

      // Try a direct script injection as a fallback
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: executeCommandDirectly,
        args: [command, Date.now()] // Pass the timestamp to help detect duplicates
      }).catch(err => {
      }).finally(() => {
        // Release the command processing lock with a longer delay
        setTimeout(() => {
          isProcessingCommand = false;
        }, 500);
      });
    });
}

// Function to send command to content script
function sendCommandToContentScript(tabId, command) {
  // Add command timestamp to allow content script to detect potential duplicates
  chrome.tabs.sendMessage(
    tabId,
    {
      action: 'controlVideo',
      command: command,
      timestamp: Date.now()
    },
    function (response) {
      // Release the command processing lock after a delay
      // Using a longer delay for better protection against rapid keypresses
      setTimeout(() => {
        isProcessingCommand = false;
      }, 500);
    }
  );
}

// Function to be injected directly if content script fails
function executeCommandDirectly(command, timestamp) {
  // Track command execution to prevent duplicates
  const lastExecutionKey = 'jsmastery_last_command_execution';

  // If we have a timestamp, check if this command was already executed
  if (timestamp) {
    const lastTimestamp = parseInt(localStorage.getItem(lastExecutionKey) || '0');
    if (timestamp - lastTimestamp < 500) {
      console.log('Direct command blocked - duplicate detected');
      return true; // Pretend success to avoid fallbacks
    }

    // Store this execution timestamp
    localStorage.setItem(lastExecutionKey, timestamp.toString());
  }

  // Try to detect the specific player pattern first (like seen in screenshot)
  const controlGroups = document.querySelectorAll('[class*="controls"], [class*="Controls"], [class*="player"], [class*="Player"]');

  for (const group of controlGroups) {
    const buttons = group.querySelectorAll('button');
    if (buttons.length >= 3) {
      // Found a potential match to the layout in the screenshot (3 buttons in a row)

      // Map commands to positions in the 3-button control layout (based on screenshot)
      const positionMap = {
        'play-pause': 0,   // Left button (pause)
        'rewind': 1,       // Middle button (-10s)
        'fast-forward': 2  // Right button (+10s)
      };

      const targetIndex = positionMap[command];
      if (targetIndex !== undefined && targetIndex < buttons.length) {
        const targetButton = buttons[targetIndex];

        try {
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
          return true;
        } catch (e) {
          // Continue to try other methods
        }
      }
    }
  }

  // Try to find video element
  const videos = document.querySelectorAll('video');
  if (videos.length > 0) {
    // Find the most relevant video (prefer playing ones)
    let video = videos[0];
    for (const v of videos) {
      if (!v.paused) {
        video = v;
        break;
      }
    }

    switch (command) {
      case 'fast-forward':
        // Look for forward button first (most reliable approach)
        const forwardButtons = [];

        // Find button by aria-label, title, and other attributes
        document.querySelectorAll(
          '[aria-label*="forward"], [aria-label*="Forward"], [aria-label*="10s"], [aria-label*="+10"], ' +
          '[title*="forward"], [title*="Forward"], [title*="10s"], [title*="+10"], ' +
          '[data-plyr="fast-forward"], ' +
          '.plyr__controls__item--forward, .vjs-skip-forward-button, .forward-button, [class*="forward"]'
        ).forEach(el => {
          if (el.tagName === 'BUTTON' || el.role === 'button') {
            forwardButtons.push(el);
          }
        });

        // Also try buttons with forward text
        document.querySelectorAll('button').forEach(btn => {
          const text = btn.textContent?.toLowerCase() || '';
          if (text.includes('forward') || text.includes('+10')) {
            forwardButtons.push(btn);
          }
        });

        // Try to click a forward button if found
        if (forwardButtons.length > 0) {
          for (const btn of forwardButtons) {
            try {
              btn.click();
              return true;
            } catch (e) {
              // Continue to next button
            }
          }
        }

        // If no buttons found, fall back to arrow key press
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          code: 'ArrowRight',
          keyCode: 39,
          which: 39,
          bubbles: true,
          cancelable: true
        }));

        setTimeout(() => {
          document.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'ArrowRight',
            code: 'ArrowRight',
            keyCode: 39,
            which: 39,
            bubbles: true,
            cancelable: true
          }));
        }, 50);

        return true;

      case 'rewind':
        // Look for rewind/back button first (most reliable approach)
        const rewindButtons = [];

        // Find button by aria-label, title, and other attributes
        document.querySelectorAll(
          '[aria-label*="rewind"], [aria-label*="Rewind"], [aria-label*="back"], [aria-label*="Back"], [aria-label*="-10"], ' +
          '[title*="rewind"], [title*="Rewind"], [title*="back"], [title*="Back"], [title*="-10"], ' +
          '[data-plyr="rewind"], ' +
          '.plyr__controls__item--rewind, .vjs-skip-backward-button, .backward-button, .rewind-button, [class*="rewind"], [class*="back"]'
        ).forEach(el => {
          if (el.tagName === 'BUTTON' || el.role === 'button') {
            rewindButtons.push(el);
          }
        });

        // Also try buttons with rewind/back text
        document.querySelectorAll('button').forEach(btn => {
          const text = btn.textContent?.toLowerCase() || '';
          if (text.includes('rewind') || text.includes('back') || text.includes('-10')) {
            rewindButtons.push(btn);
          }
        });

        // Try to click a rewind button if found
        if (rewindButtons.length > 0) {
          for (const btn of rewindButtons) {
            try {
              btn.click();
              return true;
            } catch (e) {
              // Continue to next button
            }
          }
        }

        // If no buttons found, fall back to arrow key press
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          keyCode: 37,
          which: 37,
          bubbles: true,
          cancelable: true
        }));

        setTimeout(() => {
          document.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'ArrowLeft',
            code: 'ArrowLeft',
            keyCode: 37,
            which: 37,
            bubbles: true,
            cancelable: true
          }));
        }, 50);

        return true;
      case 'play-pause':
        console.log("Executing play/pause directly");
        try {
          // Try direct video control first
          if (video.paused) {
            console.log("Video is paused, trying to play");
            const playPromise = video.play();
            if (playPromise !== undefined) {
              playPromise.catch(error => {
                console.error("Play error:", error);

                // As a fallback, try spacebar
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
              });
            }
          } else {
            console.log("Video is playing, trying to pause");
            video.pause();
          }

          // Also try space key as a fallback
          setTimeout(() => {
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
          }, 100);

          return true;
        } catch (e) {
          console.error("Error in play/pause:", e);
          return false;
        }
    }
  } else {
    // Try multiple approaches to find and click control buttons

    // 1. Check for common video player button classes and aria-labels
    const buttonSelectors = {
      'play-pause': 'button[aria-label*="play"], button[aria-label*="pause"], button.ytp-play-button, button.vjs-play-control, button[title*="play"], button[title*="pause"]',
      'rewind': 'button[aria-label*="rewind"], button[aria-label*="back"], button[aria-label*="previous"], button[title*="rewind"], button[title*="back"], button[title*="-10"]',
      'fast-forward': 'button[aria-label*="forward"], button[aria-label*="next"], button[title*="forward"], button[title*="next"], button[title*="+10"]'
    };

    if (buttonSelectors[command]) {
      const buttons = document.querySelectorAll(buttonSelectors[command]);
      if (buttons.length > 0) {

        // Click all matching buttons to maximize chances of success
        for (const button of buttons) {
          try {
            button.click();
          } catch (e) {
            console.error('Error clicking button:', e);
          }
        }
        return true;
      }
    }

    // 2. Try looking at the button contents for clues
    const innerTextMap = {
      'play-pause': ['play', 'pause'],
      'rewind': ['rewind', 'back', 'prev', '-10'],
      'fast-forward': ['forward', 'next', '+10']
    };

    const textTerms = innerTextMap[command] || [];
    const allButtons = document.querySelectorAll('button');

    for (const btn of allButtons) {
      const innerHTML = btn.innerHTML.toLowerCase();
      const innerText = btn.textContent?.toLowerCase() || '';

      for (const term of textTerms) {
        if (innerHTML.includes(term.toLowerCase()) || innerText.includes(term.toLowerCase())) {
          btn.click();
          return true;
        }
      }
    }

    // 3. Try keyboard events as a last resort
    const keyMap = {
      'fast-forward': { key: 'ArrowRight', keyCode: 39 },
      'rewind': { key: 'ArrowLeft', keyCode: 37 },
      'play-pause': { key: 'k', keyCode: 75, alt: [' ', 32] }  // Try both K and Space for play/pause
    };

    if (keyMap[command]) {
      const { key, keyCode, alt } = keyMap[command];

      // Try primary key
      ['keydown', 'keyup'].forEach(eventType => {
        document.dispatchEvent(new KeyboardEvent(eventType, {
          key: key,
          keyCode: keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true
        }));
      });

      // Try alternate key if available
      if (alt) {
        const [altKey, altKeyCode] = alt;

        ['keydown', 'keyup'].forEach(eventType => {
          document.dispatchEvent(new KeyboardEvent(eventType, {
            key: altKey,
            keyCode: altKeyCode,
            which: altKeyCode,
            bubbles: true,
            cancelable: true
          }));
        });
      }

      return true;
    }
  }

  return false;
} 