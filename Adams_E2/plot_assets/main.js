/* 
 * Adams Spectral Sequence Unified Viewer - Main JavaScript
 * 
 * This file handles the interactive visualization of the Adams Spectral Sequence
 * E₂ page for the sphere S⁰ at various primes. It provides:
 * - Mathematical data visualization (bullets = generators, lines = products)
 * - Interactive navigation (zoom, pan, selection)
 * - Multi-prime support with dynamic data loading
 * - Touch and mouse interaction handling
 */

/* ===== GLOBAL STATE AND CONFIGURATION ===== */

// Application state - tracks current mode (currently only "start" mode)
var STATE = "start";

// Global storage for the currently loaded prime's data
var DATA_JSON = {};

// Pointer/touch interaction tracking
const pointerCache = [];
var prevPtsDist = null, prevPt = null, prevPinchScale = null;
var isPointerActive = false;
var activePointerId = null;

// Calculate maximum bounds based on actual data to ensure proper viewing area
function calculateMaxBounds(data_json) {
    let x_max = 0;
    let y_max = 0;
    
    if (data_json && data_json.bullets) {
        for (const bullet of data_json.bullets) {
            x_max = Math.max(x_max, bullet.x);
            y_max = Math.max(y_max, bullet.y);
        }
    }
    
    // Add padding and extend bounds for grid - use original larger bounds as fallback
    return {
        x_max: Math.max(Math.round(x_max * 1.05), 270),
        y_max: Math.max(y_max + 10, 130)
    };
}

// Calculate maximum t-value for a given prime to show data range
function getTmaxForPrime(prime) {
    const globalVarName = 'DATA_JSON_p_' + prime + '_S0';
    if (window[globalVarName]) {
        const data = window[globalVarName];
        let tmax = 0;
        if (data && data.bullets) {
            for (const bullet of data.bullets) {
                const t = Math.round(bullet.x + bullet.y); // t = x + y in Adams grading
                if (t > tmax) {
                    tmax = t;
                }
            }
        }
        return Math.floor(tmax); // Return as integer
    }
    return 0;
}

/* 
 * CONFIGURATION OBJECTS:
 * 
 * CONFIG - Static configuration that doesn't change during runtime
 * CONFIG_DYNAMIC - Configuration that gets updated based on window size and data
 */
var CONFIG = {
    x_max: 270,                    // Maximum x-coordinate in the visualization
    y_max: 130,                    // Maximum y-coordinate in the visualization
    x_max_init: 80,                // Initial x-range to show
    margin_y: 30,                  // Margin around SVG content, X-axis side margin: 30px
    margin_x: 40,                  // Margin around SVG content, Y-axis side margin: 40px    
    axis_text_sep_screen: 60,      // Minimum screen pixels between axis labels
    camera_zoom_rate: 1.06,        // Zoom sensitivity
    camera_translate_pixels: 100,  // Pan distance per keypress (pixels)
    plot_batchSize: 1000,          // Number of elements to render per animation frame
};

var CONFIG_DYNAMIC = {
    status: "start",
    camera_unit_screen_init: (window.innerWidth - CONFIG.margin_x) / (CONFIG.x_max_init + 1), // Initial zoom level
    camera_unit_screen_min: (window.innerWidth - CONFIG.margin_x) / (CONFIG.x_max + 1),       // Minimum zoom (fully zoomed out)
    camera_unit_screen_max: Math.min(window.innerWidth, window.innerHeight) - 30,           // Maximum zoom (fully zoomed in)
};

// Available primes and currently selected prime
const AVAILABLE_PRIMES = [3, 5, 7, 11];
var CURRENT_PRIME = 3;

/* ===== MATHEMATICAL UTILITIES ===== */

/* 
 * Vector class for 2D coordinate math
 * Used for world coordinates (mathematical space) and screen coordinates (pixels)
 */
class Vector {
    constructor(x, y) {
        this.x = x || 0;
        this.y = y || 0;
    }
    add(v) {
        return new Vector(this.x + v.x, this.y + v.y);
    }
    sub(v) {
        return new Vector(this.x - v.x, this.y - v.y);
    }
    mul(r) {
        return new Vector(this.x * r, this.y * r);
    }
    dist(v) {
        return Math.sqrt((this.x - v.x) * (this.x - v.x) + (this.y - v.y) * (this.y - v.y));
    }
}

// Utility function to constrain values between min and max
function clip(x, min_, max_) {
    if (x < min_) return min_;
    else if (x > max_) return max_;
    else return x;
}

/* ===== CAMERA SYSTEM ===== */

/* 
 * Camera system handles the viewport transformation between:
 * - World coordinates (mathematical (x,y) in the spectral sequence)
 * - SVG coordinates (pixels on screen)
 * 
 * Implements zooming (scale) and panning (translation)
 */
const camera = {
    unit_svg: CONFIG_DYNAMIC.camera_unit_screen_init, // Current scale factor (world units per pixel)
    o_svg: new Vector(                                // Current origin offset (pixels)
        CONFIG.margin_x + 0.5 * CONFIG_DYNAMIC.camera_unit_screen_init,
        CONFIG.margin_y + 0.5 * CONFIG_DYNAMIC.camera_unit_screen_init 
    ),
    
    // Zoom in/out around a pivot point (mouse position)
    zoom: function (pivotSvg, rate) {
        let unit_svg1 = clip(this.unit_svg * rate, CONFIG_DYNAMIC.camera_unit_screen_min, CONFIG_DYNAMIC.camera_unit_screen_max);
        let rate1 = unit_svg1 / this.unit_svg;
        this.unit_svg = unit_svg1;

        // Adjust origin to zoom around pivot point
        let origin_sp1 = pivotSvg.add(this.o_svg.sub(pivotSvg).mul(rate1));
        
        // Constrain camera to stay within data bounds
        let x_min = window.innerWidth - (CONFIG.x_max + 0.5) * this.unit_svg;
        let x_max = CONFIG.margin_x + 0.5 * this.unit_svg;
        let y_min = window.innerHeight - (CONFIG.y_max + 0.5) * this.unit_svg;
        let y_max = CONFIG.margin_y + 0.5 * this.unit_svg;
        if (y_min > y_max) y_min = y_max;
        
        this.o_svg = new Vector(clip(origin_sp1.x, x_min, x_max), clip(origin_sp1.y, y_min, y_max));
        camera.setTransform();
        updateAxisLabels();
    },
    
    // Pan the view by a delta vector (pixels)
    translate: function (deltaSvg) {
        let origin_sp1 = this.o_svg.add(deltaSvg);
        
        // Constrain panning to data bounds
        let x_min = window.innerWidth - (CONFIG.x_max + 0.5) * this.unit_svg;
        let x_max = CONFIG.margin_x + 0.5 * this.unit_svg;
        let y_min = window.innerHeight - (CONFIG.y_max + 0.5) * this.unit_svg;
        let y_max = CONFIG.margin_y + 0.5 * this.unit_svg;
        if (y_min > y_max) y_min = y_max;
        
        this.o_svg = new Vector(clip(origin_sp1.x, x_min, x_max), clip(origin_sp1.y, y_min, y_max));
        camera.setTransform();
        updateAxisLabels();
    },
    
    // Convert world coordinates to SVG pixel coordinates
    world2svg: function (ptWorld) {
        return this.o_svg.add(ptWorld.mul(this.unit_svg));
    },
    
    // Convert SVG pixel coordinates to world coordinates  
    svg2world: function (ptSvg) {
        return ptSvg.sub(this.o_svg).mul(1 / this.unit_svg);
    },
    
    // Flip y-coordinate (SVG has origin at top-left, math has origin at bottom-left)
    flip: function (ptScreen) {
        return new Vector(ptScreen.x, window.innerHeight - ptScreen.y);
    },
    
    // Apply current transform to the plot group
    setTransform: function () {
        g_plot.setAttribute("transform", "translate(" + this.o_svg.x + "," + this.o_svg.y + ") scale(" + this.unit_svg + ")");
    }
};

/* ===== GLOBAL ELEMENT REFERENCES ===== */

// SVG and group elements for the visualization
var svg_ss, g_svg, g_plot, g_bullets, g_strtlines, g_labels, g_xaxis, g_yaxis;
var circle_mouseon, rect_selected, g_prod, div_menu_style;
var bullet_selected = null;

/* ===== INITIALIZATION AND SETUP ===== */

// Initialize references to DOM elements
function initializeElements() {
    svg_ss = document.getElementById("svg_ss");
    g_svg = document.getElementById("g_svg");
    g_plot = document.getElementById("g_plot");
    
    // Bullet containers for different colors (currently only black used)
    g_bullets = {
        "black": document.getElementById("g_bullets_black"),
        "blue": document.getElementById("g_bullets_blue"),
        "grey": document.getElementById("g_bullets_grey")
    };
    
    g_strtlines = document.getElementById("g_strtlines");
    g_labels = document.getElementById("g_labels");
    g_xaxis = document.getElementById("g_xaxis");
    g_yaxis = document.getElementById("g_yaxis");
    circle_mouseon = document.getElementById("circle_mouseon");
    rect_selected = document.getElementById("rect_selected");
    g_prod = document.getElementById("g_prod");
    div_menu_style = document.getElementById("div_menu").style;
    
    // Set up SVG dimensions and coordinate system
    svg_ss.setAttribute("width", window.innerWidth);
    svg_ss.setAttribute("height", window.innerHeight);
    g_svg.setAttribute("transform", "translate(0," + window.innerHeight + ") scale(1,-1)"); // Flip y-axis
}

// Handle window resize events
function windowResize() {
    svg_ss.setAttribute("width", window.innerWidth);
    svg_ss.setAttribute("height", window.innerHeight);
    g_svg.setAttribute("transform", "translate(0," + window.innerHeight + ") scale(1,-1)");
    // Update dynamic config based on new window size
    CONFIG_DYNAMIC.camera_unit_screen_min = (window.innerWidth - CONFIG.margin_x) / (CONFIG.x_max + 1);
    CONFIG_DYNAMIC.camera_unit_screen_max = Math.min(window.innerWidth, window.innerHeight) - 30;
}

/* ===== AXIS AND GRID SYSTEM ===== */

// Simple identity function for axis numbers (could be extended for formatting)
function getAxisNumber(x) { return x; }

// Update axis labels based on current viewport and zoom level
function updateAxisLabels() {
    var stepLabel = Math.ceil(CONFIG.axis_text_sep_screen / camera.unit_svg);
    let i_min = Math.ceil(camera.svg2world(new Vector(30, 0)).x / stepLabel) * stepLabel;
    let i_max = Math.floor(camera.svg2world(new Vector(window.innerWidth, 0)).x);
    g_xaxis.innerHTML = "";
    
    // Create x-axis labels (t-s coordinate)
    for (let i = i_min; i <= i_max; i += stepLabel) {
        let xText = camera.world2svg(new Vector(i, 0)).x;
        let label = '<text x="' + xText + '" y="-10">' + getAxisNumber(i) + '</text>';
        g_xaxis.insertAdjacentHTML("beforeend", label);
    }
    
    // Create y-axis labels (s coordinate)
    i_min = Math.ceil(camera.svg2world(new Vector(0, 30)).y / stepLabel) * stepLabel;
    i_max = Math.floor(camera.svg2world(new Vector(0, window.innerHeight)).y);
    g_yaxis.innerHTML = "";
    for (let i = i_min; i <= i_max; i += stepLabel) {
        let yText = camera.world2svg(new Vector(0, i)).y;
        let label = '<text x="36" y="' + (-yText) + '" dy="0.25em">' + i + '</text>';
        g_yaxis.insertAdjacentHTML("beforeend", label);
    }
}

// Create the coordinate grid background with consistent appearance
function addGridLines() {
    const g_grid = document.getElementById("g_grid");
    g_grid.innerHTML = '';
    
    // Use consistent grid style across browsers
    const gridStyle = 'stroke="#e0e0e0" stroke-width="0.015" stroke-opacity="0.6"';

    // Add horizontal grid lines
    for (let i = 0; i <= CONFIG.y_max; i += 1) {
        const line = `<line x1="-0.5" y1="${i}" x2="${CONFIG.x_max + 0.5}" y2="${i}" ${gridStyle}></line>`;
        g_grid.insertAdjacentHTML("beforeend", line);
    }

    // Add vertical grid lines
    for (let i = 0; i <= CONFIG.x_max; i += 1) {
        const line = `<line x1="${i}" y1="-.5" x2="${i}" y2="${CONFIG.y_max}" ${gridStyle}></line>`;
        g_grid.insertAdjacentHTML("beforeend", line);
    }
}

/* ===== POINTER/TOUCH INTERACTION SYSTEM ===== */

// Calculate distance between two pointer points for pinch gestures
function getDistPts() {
    let p1Screen = new Vector(pointerCache[0].clientX, pointerCache[0].clientY);
    let p2Screen = new Vector(pointerCache[1].clientX, pointerCache[1].clientY);
    return p1Screen.dist(p2Screen);
}

// Clean up pointer cache to prevent accumulation of stale pointers
function cleanupPointerCache() {
    // Simply ensure we don't accumulate more than 2 pointers
    // This handles the case where pointer events might get "stuck"
    if (pointerCache.length > 2) {
        pointerCache.length = 2;
    }
}

// Cleanup function for pointer state
function cleanupPointerState() {
    pointerCache.length = 0;
    prevPt = null;
    prevPtsDist = null;
    isPointerActive = false;
    activePointerId = null;
    
    // Remove global listeners
    document.removeEventListener('pointerup', handleGlobalPointerUp);
    document.removeEventListener('pointercancel', handleGlobalPointerCancel);
}

// Global pointer event handlers for out-of-viewport release
function handleGlobalPointerUp(event) {
    if (event.pointerId === activePointerId) {
        cleanupPointerState();
    }
}

function handleGlobalPointerCancel(event) {
    if (event.pointerId === activePointerId) {
        cleanupPointerState();
    }
}

// Handle pointer down events (mouse down or touch start)
function on_pointerdown(event) {
    if (STATE === "start" && event.button === 0) { // Only handle left mouse button
        div_menu_style.visibility = "hidden"; // Hide context menu
        pointerCache.push(event);

        // Track active pointer state
        isPointerActive = true;
        activePointerId = event.pointerId;

        // Capture pointer to track movements outside element
        event.target.setPointerCapture(event.pointerId);

        // Clean up cache if needed
        cleanupPointerCache();

        // Add global pointer event listeners to handle out-of-viewport release
        document.addEventListener('pointerup', handleGlobalPointerUp);
        document.addEventListener('pointercancel', handleGlobalPointerCancel);

        // Initialize tracking based on number of pointers
        if (pointerCache.length === 1) {
            prevPt = new Vector(event.clientX, event.clientY); // Single pointer - prepare for panning
        } else if (pointerCache.length === 2) {
            prevPtsDist = getDistPts(); // Two pointers - prepare for pinch-to-zoom
        }
    }
}

// Handle pointer move events (mouse move or touch move)
function on_pointermove(event) {
    if (STATE === "start") {
        let index = 0;
        // Update the moving pointer in cache
        for (; index < pointerCache.length; index++) {
            if (event.pointerId === pointerCache[index].pointerId) {
                pointerCache[index] = event;
                break;
            }
        }

        // Clean up cache if needed (in case of weird pointer behavior)
        cleanupPointerCache();

        // Single pointer movement - pan the camera
        if (pointerCache.length === 1 && index < pointerCache.length) {
            let curPt = new Vector(event.clientX, event.clientY);
            let deltaScreen = curPt.sub(prevPt);
            camera.translate(new Vector(deltaScreen.x, -deltaScreen.y)); // Note: y is inverted
            prevPt = curPt;
        }

        // Two pointer movement - pinch to zoom
        if (pointerCache.length === 2 && index < pointerCache.length) {
            let p1Svg = camera.flip(new Vector(pointerCache[0].clientX, pointerCache[0].clientY));
            let p2Svg = camera.flip(new Vector(pointerCache[1].clientX, pointerCache[1].clientY));
            let curDist = p1Svg.dist(p2Svg);
            camera.zoom(index === 0 ? p2Svg : p1Svg, curDist / prevPtsDist);
            prevPtsDist = curDist;
        }
    }
}

// Remove a pointer from the cache by ID
function removeEvent(event_id) {
    for (let i = 0; i < pointerCache.length; i++) {
        if (pointerCache[i].pointerId === event_id) {
            pointerCache.splice(i, 1);
            return true;
        }
    }
    return false;
}

// Handle pointer up events (mouse up or touch end)
function on_pointerup(event) {
    if (STATE === "start" && event.button === 0) {
        // Release pointer capture
        event.target.releasePointerCapture(event.pointerId);

        if (removeEvent(event.pointerId)) {
            // Update tracking after pointer removal
            if (pointerCache.length === 0) {
                prevPt = null;
                isPointerActive = false;
                activePointerId = null;
            } else if (pointerCache.length === 1) {
                prevPt = new Vector(pointerCache[0].clientX, pointerCache[0].clientY);
            } else if (pointerCache.length === 2) {
                prevPtsDist = getDistPts();
            }
        }

        // Check if a bullet was clicked
        const bullet = event.target;
        if (bullet.classList.contains("b")) select_bullet(bullet);

        cleanupPointerCache();
        
        // Remove global listeners if no more active pointers
        if (pointerCache.length === 0) {
            document.removeEventListener('pointerup', handleGlobalPointerUp);
            document.removeEventListener('pointercancel', handleGlobalPointerCancel);
        }
    }
}

// Handle window blur to catch cases where window loses focus
function handleWindowBlur() {
    if (isPointerActive) {
        cleanupPointerState();
        console.log("Pointer state cleaned up due to window blur");
    }
}

/* ===== BULLET SELECTION AND PRODUCT VISUALIZATION ===== */

// Select a bullet and highlight its products
function select_bullet(bullet) {
    // Deselect previously selected bullet
    if (bullet_selected !== null) {
        bullet_selected.removeAttribute("fill");
        bullet_selected = null;
    }
    
    // Select new bullet
    bullet_selected = bullet;
    bullet_selected.setAttribute("fill", "red"); // Highlight selected bullet in red
    
    // Position selection rectangle
    rect_selected.setAttribute("x", Math.round(bullet.getAttribute("cx")) - 0.5);
    rect_selected.setAttribute("y", Math.round(bullet.getAttribute("cy")) - 0.5);

    // Clear previous product highlights
    g_prod.innerHTML = "";
    let prods = DATA_JSON["prods"][bullet.dataset.i];
    
    // Show products as green circles
    if (prods) {
        for (const j in prods) {
            for (const i of prods[j]['p']) {
                const bullet2 = DATA_JSON["bullets"][i];
                const circle_prod = '<circle class="p" cx="' + bullet2.x + '" cy="' + bullet2.y + '" r="' + (bullet2['r'] * 1.7) + '" fill="green" opacity="0.7" data-i=' + i + '></circle>';
                g_prod.insertAdjacentHTML("beforeend", circle_prod);
            }
        }
    }
}

/* ===== ALTERNATIVE INPUT METHODS ===== */

// Handle mouse wheel zoom
function on_wheel(event) {
    let pivotScreen = new Vector(event.clientX, event.clientY);
    let pivotSvg = camera.flip(pivotScreen);
    camera.zoom(pivotSvg, event.deltaY < 0 ? CONFIG.camera_zoom_rate : 1 / CONFIG.camera_zoom_rate);
    event.preventDefault();
}

// Handle Mac trackpad pinch gestures
function on_pinch(event) {
    let pivotScreen = new Vector(event.clientX, event.clientY);
    let pivotSvg = camera.flip(pivotScreen);
    camera.zoom(pivotSvg, event.scale / prevPinchScale);
    prevPinchScale = event.scale;
    event.preventDefault();
}

// Handle keyboard navigation
function on_key_down(event) {
    if (!event.shiftKey) {
        if (event.which === 39) camera.translate(new Vector(-CONFIG.camera_translate_pixels, 0)); // Right arrow
        else if (event.which === 37) camera.translate(new Vector(CONFIG.camera_translate_pixels, 0)); // Left arrow
        else if (event.which === 38) camera.translate(new Vector(0, -CONFIG.camera_translate_pixels)); // Up arrow
        else if (event.which === 40) camera.translate(new Vector(0, CONFIG.camera_translate_pixels)); // Down arrow
        else if (event.which === 189) { // Minus key - zoom out
            const pivotSvg = new Vector(window.innerWidth / 2, window.innerHeight / 2);
            camera.zoom(pivotSvg, 1 / CONFIG.camera_zoom_rate);
        } else if (event.which === 187) { // Plus key - zoom in
            const pivotSvg = new Vector(window.innerWidth / 2, window.innerHeight / 2);
            camera.zoom(pivotSvg, CONFIG.camera_zoom_rate);
        }
    }
}

/* ===== BULLET HOVER EFFECTS ===== */

// Show highlight circle when hovering over a bullet
function on_pointerenter_bullet(event) {
    let tgt = event.target;
    circle_mouseon.setAttribute("cx", tgt.getAttribute("cx"));
    circle_mouseon.setAttribute("cy", tgt.getAttribute("cy"));
    circle_mouseon.setAttribute("r", Number(tgt.getAttribute("r")) * 1.3); // Slightly larger than bullet
}

// Hide highlight circle when leaving bullet
function on_pointerleave_bullet(event) {
    circle_mouseon.setAttribute("cx", "-1000"); // Move off-screen
}

/* ===== CUSTOM MODAL SYSTEM ===== */

// Show custom modal dialog with proper sizing and no scrolling
function showCustomModal(title, content) {
    // Remove existing modal if any
    const existingModal = document.getElementById('custom-modal');
    if (existingModal) {
        document.body.removeChild(existingModal);
    }

    // Create modal container
    const modal = document.createElement('div');
    modal.id = 'custom-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 10000;
        font-family: sans-serif;
    `;

    // Create modal content with proper width control
    const modalContent = document.createElement('div');
    modalContent.style.cssText = `
        background: white;
        padding: 30px;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        
        /* PROPER WIDTH CONTROL */
        width: 500px;               /* Optimal reading width */
        max-width: 90vw;            /* Never exceed 90% of viewport */
        min-width: 300px;           /* Never get too narrow */
        
        /* HEIGHT CONTROL */
        max-height: 80vh;           /* Comfortable max height */
        
        /* LAYOUT */
        display: flex;
        flex-direction: column;
        word-wrap: break-word;
    `;

    // Create title
    const titleElement = document.createElement('h3');
    titleElement.textContent = title;
    titleElement.style.cssText = `
        margin: 0 0 20px 0;
        color: #333;
        font-size: 22px;
        font-weight: bold;
        text-align: center;
    `;

    // Create content area
    const contentElement = document.createElement('div');
    contentElement.textContent = content;
    contentElement.style.cssText = `
        color: #555;
        line-height: 1.6;
        white-space: pre-line;
        user-select: text;
        -webkit-user-select: text;
        -moz-user-select: text;
        -ms-user-select: text;
        flex: 1;
        margin-bottom: 25px;
        font-size: 15px;
        text-align: left;
    `;

    // Create close button
    const closeButton = document.createElement('button');
    closeButton.textContent = 'Close';
    closeButton.style.cssText = `
        padding: 12px 24px;
        background: #3879d9;
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 16px;
        align-self: center;
        min-width: 100px;
    `;
    closeButton.onclick = function() {
        document.body.removeChild(modal);
    };

    // Assemble modal
    modalContent.appendChild(titleElement);
    modalContent.appendChild(contentElement);
    modalContent.appendChild(closeButton);
    modal.appendChild(modalContent);
    document.body.appendChild(modal);

    // Close modal when clicking outside content
    modal.onclick = function(event) {
        if (event.target === modal) {
            document.body.removeChild(modal);
        }
    };

    // Close with Escape key
    const keyHandler = function(event) {
        if (event.key === 'Escape') {
            document.body.removeChild(modal);
            document.removeEventListener('keydown', keyHandler);
        }
    };
    document.addEventListener('keydown', keyHandler);
}

/* ===== CONTEXT MENU SYSTEM ===== */

// Show context menu on right-click
function on_contextmenu(event) {
    if (!event.ctrlKey) { // Allow Ctrl+right-click for browser context menu
        let posX = event.clientX;
        let posY = event.clientY;

        // Position menu based on which element was right-clicked
        if (event.target.id === "button_cm") {
            div_menu_style.left = null;
            div_menu_style.right = (window.innerWidth - posX) + "px"; // Position relative to right edge
        } else {
            div_menu_style.left = posX + "px";
            div_menu_style.right = null; // Position relative to left edge
        }
        div_menu_style.top = posY + "px";
        div_menu_style.visibility = "visible";
        event.preventDefault(); // Prevent browser context menu
    }
}

// Format timestamp for display in about dialog
function formatTimestamp(timestamp) {
    if (!timestamp) return "Unknown";
    
    try {
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) {
            // If it's not a valid date string, try to parse it differently
            const parts = timestamp.split(' ')[0].split('-'); // YYYY-MM-DD format
            if (parts.length === 3) {
                const year = parseInt(parts[0]);
                const month = parseInt(parts[1]) - 1;
                const day = parseInt(parts[2]);
                const dateObj = new Date(year, month, day);
                if (!isNaN(dateObj.getTime())) {
                    return dateObj.toLocaleDateString('en-US', { 
                        year: 'numeric', 
                        month: 'long', 
                        day: 'numeric' 
                    });
                }
            }
            return timestamp; // Return original if can't parse
        }
        
        return date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });
    } catch (e) {
        return timestamp;
    }
}

// Show about and metadata dialog
function on_about_metadata() {
    let message = "Adams Spectral Sequence for S⁰ (Odd Primes)\n\n";
    message += "This visualization displays the E₂ page for the sphere at odd primes, computed within the following ranges:\n";
    
    // Calculate tmax for each prime
    AVAILABLE_PRIMES.forEach(prime => {
        const tmax = getTmaxForPrime(prime);
        message += `* p = ${prime}: t ≤ ${tmax}\n`;
    });
    
    message += "\n";
    message += "Developed by: Weinan Lin and Yu Zhang\n";
    
    // Get time info from current data
    if (DATA_JSON && DATA_JSON.time) {
        const formattedTime = formatTimestamp(DATA_JSON.time);
        message += `Last updated: ${formattedTime}`;
    } else {
        message += "Last updated: Unknown";
    }

    showCustomModal("About & Metadata", message);
}

// Show help dialog with navigation instructions
function showHelp() {
    const helpText = "Navigation:\n• Pan: Click and drag, or use the arrow keys\n• Zoom: Mouse wheel, pinch gesture, or +/- keys\n• Products: Black lines show multiplication by a₀ and h₀\n• Select element: Click on any dot. Product results are highlighted with green circles\n\nURL Parameters:\n• prime=3,5,7,11 - Select an odd prime\n• scale=2 - Set zoom level (larger values = more zoomed in)\n• x=10 - Set horizontal coordinate for the center viewport\n• y=5 - Set vertical coordinate for the center viewport\n\nExamples URLs:\n• unified_viewer.html?prime=5\n• unified_viewer.html?prime=3&scale=2&x=140&y=20\n• unified_viewer.html?prime=7&scale=0.5&x=500&y=40";
    
    showCustomModal("Help", helpText);
}

// Update visibility of elements (currently minimal implementation)
function updateVisibility() {
    for (const ele of document.getElementsByClassName("p")) {
        ele.removeAttribute("style");
    }
}

/* ===== EVENT HANDLER INITIALIZATION ===== */

// Set up all event listeners
function initHandlers() {
    svg_ss.addEventListener("wheel", on_wheel);
    svg_ss.addEventListener("pointerdown", on_pointerdown);
    svg_ss.addEventListener("pointermove", on_pointermove);
    svg_ss.addEventListener("pointerup", on_pointerup);
    svg_ss.addEventListener("contextmenu", on_contextmenu);
    document.addEventListener("keydown", on_key_down);

    // Hide context menu when clicked
    const div_menu = document.getElementById("div_menu");
    div_menu.onclick = function(event) { div_menu_style.visibility = "hidden"; };

    // Set up Mac-specific gesture handling
    if (navigator.userAgent.match("Macintosh")) {
        window.addEventListener("gesturestart", function(event) { prevPinchScale = 1.0; event.preventDefault(); });
        window.addEventListener("gesturechange", on_pinch);
        window.addEventListener("gestureend", function(event) { event.preventDefault(); });
        //CONFIG.camera_zoom_rate = 1.06; // More sensitive zoom on Mac
    }
}

/* ===== PLOTTING AND RENDERING SYSTEM ===== */

// Clear all plotted elements from the visualization
function clearPlot() {
    g_bullets["black"].innerHTML = "";
    g_bullets["blue"].innerHTML = "";
    g_bullets["grey"].innerHTML = "";
    g_strtlines.innerHTML = "";
    g_prod.innerHTML = "";
    g_labels.innerHTML = "";
    
    // Clear selection state
    if (bullet_selected !== null) {
        bullet_selected.removeAttribute("fill");
        bullet_selected = null;
    }
    rect_selected.setAttribute("x", "-1000");
    circle_mouseon.setAttribute("cx", "-1000");
}

// Progressive rendering function - loads data in batches to prevent UI freezing
function loadPlot(data_json) {
    const xshift = "shift" in data_json ? data_json.shift : 0;
    const xfactor = "factor" in data_json ? data_json.factor : 1;
    const trans = function(x) { return ((x - Math.round(x)) + Math.round(x) * xfactor + xshift); };
    
    // SIMPLIFIED: Since all bullets are currently black, use single batch
    let bulletsHTML = "";
    let elementsProcessed = 0;
    
    // Process bullets in batch
    for (; data_json.iPlotB < data_json["bullets"].length && elementsProcessed < CONFIG.plot_batchSize; data_json.iPlotB++) {
        const bullet = data_json["bullets"][data_json.iPlotB];
        const ele_bullet = '<circle data-i="' + data_json.iPlotB + '" class="p b ' + data_json.class + '" cx="' + trans(bullet.x) + '" cy="' + bullet.y + '" r="' + bullet.r + '"> </circle>';
        
        bulletsHTML += ele_bullet;
        elementsProcessed++;
    }
    
    // SINGLE DOM INSERTION for all bullets in this batch (performance optimization)
    if (bulletsHTML) {
        g_bullets["black"].insertAdjacentHTML("beforeend", bulletsHTML);
    }
    
    // Process structure lines (product relationships)
    let keys_prods = Object.keys(data_json["prods"]);
    let linesHTML = "";
    let linesProcessed = 0;
    
    for (; data_json.iPlotSL < keys_prods.length && linesProcessed < CONFIG.plot_batchSize / 2; data_json.iPlotSL++) {
        const lines = data_json["prods"][keys_prods[data_json.iPlotSL]];
        for (const line of lines) {
            if (line['l'] == 0) continue; // Skip zero lines
            const bullet1 = data_json["bullets"][keys_prods[data_json.iPlotSL]];
            for (const i of line["p"]) {
                const bullet2 = data_json["bullets"][i];
                const width = Math.min(bullet1['r'], bullet2['r']) / 4; // Line width proportional to bullet size
                const ele_line = '<line class="p sl ' + data_json.class + '" x1="' + trans(bullet1.x) + '" y1="' + bullet1.y + '" x2="' + trans(bullet2.x) + '" y2="' + bullet2.y + '" stroke="black" stroke-width="' + width + '"> </line>';
                linesHTML += ele_line;
                linesProcessed++;
                
                if (linesProcessed >= CONFIG.plot_batchSize / 2) break; // Respect batch size limit
            }
            if (linesProcessed >= CONFIG.plot_batchSize / 2) break;
        }
        if (linesProcessed >= CONFIG.plot_batchSize / 2) break;
    }
    
    // BULK INSERTION for structure lines
    if (linesHTML) {
        g_strtlines.insertAdjacentHTML("beforeend", linesHTML);
    }
    
    // Continue progressive rendering if more data remains
    if (data_json.iPlotB < data_json["bullets"].length || data_json.iPlotSL < keys_prods.length) {
        requestAnimationFrame(function() { loadPlot(data_json); });
    } else {
        // Final setup after all data is loaded
        if (navigator.userAgent.match("Windows") || navigator.userAgent.match("Macintosh")) {
            const bullets = document.getElementsByClassName("b");
            for (const b of bullets) {
                b.onpointerenter = on_pointerenter_bullet;
                b.onpointerleave = on_pointerleave_bullet;
            }
        }
        updateVisibility();
        updateAxisLabels();
    }
}

// Start the plotting process for a dataset
function Plot(data_json) {
    if (["ring", "module"].includes(data_json["type"])) {
        data_json.iPlotB = 0; // Reset bullet plot index
        data_json.iPlotSL = 0; // Reset structure line plot index
        requestAnimationFrame(function() { loadPlot(data_json); }); // Start progressive rendering
    }
}

/* ===== PRIME SELECTION AND URL PARAMETER SYSTEM ===== */

// Parse URL parameters for initial configuration
function getUrlParams() {
    const params = new URLSearchParams(window.location.search);
    return {
        prime: parseInt(params.get('prime')) || 3, // Default to prime 3
        scale: parseFloat(params.get('scale')),    // Optional zoom scale
        x: parseFloat(params.get('x')),            // Optional x-coordinate center
        y: parseFloat(params.get('y'))             // Optional y-coordinate center
    };
}

// Update URL to reflect current prime selection
function updateUrlParams(prime) {
    const url = new URL(window.location);
    url.searchParams.set('prime', prime);
    // Remove scale, x, y parameters when switching primes to use default region
    url.searchParams.delete('scale');
    url.searchParams.delete('x');
    url.searchParams.delete('y');
    window.history.replaceState(null, '', url); // Update URL without page reload
}

// Switch to a different prime
function switchPrime(prime) {
    if (prime === CURRENT_PRIME) return;
    
    CURRENT_PRIME = prime;
    updateUrlParams(prime);
    loadPrimeData(prime);
}

// Create the prime selection dropdown in the menubar
function createPrimeSelector() {
    const container = document.getElementById('div_menubar');
    container.innerHTML = '';
    
    // Create prime selector
    const select = document.createElement('select');
    select.id = 'select_prime';
    select.onchange = function(event) { switchPrime(parseInt(event.target.value)); };
    
    AVAILABLE_PRIMES.forEach(function(prime) {
        const option = document.createElement('option');
        option.value = prime;
        option.textContent = 'Prime ' + prime;
        if (prime === CURRENT_PRIME) {
            option.selected = true;
        }
        select.appendChild(option);
    });
    
    container.appendChild(select);
    
    // Add context menu button
    const button = document.createElement('button');
    button.id = 'button_cm';
    button.textContent = '︙'; // Vertical ellipsis character
    button.onclick = on_contextmenu;
    container.appendChild(button);
}

// Reset camera to default viewing region for a prime
function setCameraToDefaultRegion(prime) {
    // Reset to original camera position
    camera.unit_svg = CONFIG_DYNAMIC.camera_unit_screen_init;
    camera.o_svg = new Vector(
        CONFIG.margin_x + 0.5 * CONFIG_DYNAMIC.camera_unit_screen_init,
        CONFIG.margin_y + 0.5 * CONFIG_DYNAMIC.camera_unit_screen_init
    );
    
    camera.setTransform();
    updateAxisLabels();
}

// Set camera position based on URL parameters
function setCameraPosition(scale, x, y) {
    if (scale !== null && !isNaN(scale)) {
        // Set zoom level
        const targetUnit = CONFIG_DYNAMIC.camera_unit_screen_init * scale;
        camera.unit_svg = clip(targetUnit, CONFIG_DYNAMIC.camera_unit_screen_min, CONFIG_DYNAMIC.camera_unit_screen_max);
    }
    
    if (x !== null && !isNaN(x) && y !== null && !isNaN(y)) {
        // Set camera position to center on (x, y)
        const targetSvgX = CONFIG.margin_x + (window.innerWidth - CONFIG.margin_x) / 2;
        const targetSvgY = CONFIG.margin_y + (window.innerHeight - CONFIG.margin_y) / 2;
        
        const currentWorld = camera.svg2world(new Vector(targetSvgX, targetSvgY));
        const deltaX = x - currentWorld.x;
        const deltaY = y - currentWorld.y;
        
        camera.o_svg.x -= deltaX * camera.unit_svg;
        camera.o_svg.y -= deltaY * camera.unit_svg;
    }
    
    camera.setTransform();
    updateAxisLabels();
}

// Load and display data for a specific prime
function loadPrimeData(prime) {
    const globalVarName = 'DATA_JSON_p_' + prime + '_S0';
    
    if (window[globalVarName]) {
        DATA_JSON = window[globalVarName];
        clearPlot();
        
        // Update bounds based on actual data
        const bounds = calculateMaxBounds(DATA_JSON);
        CONFIG.x_max = bounds.x_max;
        CONFIG.y_max = bounds.y_max;
        CONFIG_DYNAMIC.camera_unit_screen_min = (window.innerWidth - CONFIG.margin_x) / (CONFIG.x_max + 1);
        
        // Update grid to match data bounds
        addGridLines();
        
        DATA_JSON.class = "cw"; // CSS class for the visualization
        Plot(DATA_JSON);
        createPrimeSelector();
        
        // Set default region
        setCameraToDefaultRegion(prime);
        
        // Update page title like original
        document.title = "Adams E₂ for S⁰ at prime " + prime;
        
        console.log("Loaded data for prime " + prime + ", bounds: x_max=" + CONFIG.x_max + ", y_max=" + CONFIG.y_max);
    } else {
        console.error("Data for prime " + prime + " not found. Global variable " + globalVarName + " is not defined.");
        alert("Data for prime " + prime + " is not available. Please generate the data files first.");
    }
}

// Process URL parameters after data is loaded
function processUrlParams(params) {
    // Only process URL params if they are explicitly provided
    const hasScale = params.scale !== null && !isNaN(params.scale);
    const hasX = params.x !== null && !isNaN(params.x);
    const hasY = params.y !== null && !isNaN(params.y);
    
    if (hasScale || hasX || hasY) {
        // Use URL parameters
        setCameraPosition(
            hasScale ? params.scale : 1,
            hasX ? params.x : 0,
            hasY ? params.y : 0
        );
    } else {
        // Use default region for current prime
        setCameraToDefaultRegion(CURRENT_PRIME);
    }
}

/* ===== MAIN INITIALIZATION ===== */

// Initialize the entire application
function initializeSystem() {
    initializeElements();
    initHandlers();
    addGridLines();
    
    // Add window blur handler for pointer cleanup
    window.addEventListener('blur', handleWindowBlur);
    
    const params = getUrlParams();
    CURRENT_PRIME = params.prime;
    
    // Load initial prime data
    loadPrimeData(CURRENT_PRIME);
    
    // Process URL parameters after data is loaded
    setTimeout(function() {
        processUrlParams(params);
    }, 100);
    
    // Set up window resize handler
    window.addEventListener("resize", windowResize);
    
    console.log("Adams Spectral Sequence Unified Viewer initialized");
    console.log("Available primes: " + AVAILABLE_PRIMES);
    console.log("Current prime: " + CURRENT_PRIME);
}

// Initialize when the page loads
window.addEventListener("load", initializeSystem);