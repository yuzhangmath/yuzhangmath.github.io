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

// Global storage for the currently loaded compact dataset view
var DATA_JSON = {};
var ACTIVE_VIEW = null;
var DATA_LOADER = null;
var PLOT_CONTROLLER = null;
var SELECTION_LIFECYCLE = null;

var ROOT = typeof globalThis !== "undefined" ? globalThis : window;
var RENDER_CORE = ROOT.AdamsE2RenderCore;
var DATA_LOADER_API = ROOT.AdamsE2DataLoader;
var RENDER_GENERATIONS = new RENDER_CORE.RenderGenerations();

function getRuntimeManifest() {
    return ROOT.__MYADAMSP2_E2_MANIFEST_V2__ || null;
}

function getDatasetEntries() {
    const manifest = getRuntimeManifest();
    return Object.keys(manifest.datasets)
        .map(key => manifest.datasets[key])
        .sort((left, right) => left.prime - right.prime);
}

function getManifestEntryForPrime(prime) {
    return getDatasetEntries().find(entry => entry.prime === prime) || null;
}

function getAvailablePrimes() {
    return getDatasetEntries().map(entry => entry.prime);
}

// Pointer/touch interaction tracking
const pointerCache = [];
const POINTER_CLICK_TRACKER = RENDER_CORE.createPointerClickTracker();
var prevPtsDist = null, prevPt = null, prevPinchScale = null;
var isPointerActive = false;

// Calculate maximum bounds based on actual data to ensure proper viewing area
function calculateMaxBounds(view) {
    let x_max = 0;
    let y_max = 0;
    
    if (view && typeof view.count === "number") {
        for (let index = 0; index < view.count; index++) {
            const layout = view.layout(index);
            x_max = Math.max(x_max, layout.x);
            y_max = Math.max(y_max, layout.y);
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
    const entry = getManifestEntryForPrime(prime);
    return entry ? entry.effectiveTMax : 0;
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
    point_label_collision_padding: 4,
    point_label_zoom_reflow_delay: 120,
    point_label_gaps: [10, 34, 64],
    point_label_viewport_padding: 8,
};

var CONFIG_DYNAMIC = {
    status: "start",
    camera_unit_screen_init: (window.innerWidth - CONFIG.margin_x) / (CONFIG.x_max_init + 1), // Initial zoom level
    camera_unit_screen_min: (window.innerWidth - CONFIG.margin_x) / (CONFIG.x_max + 1),       // Minimum zoom (fully zoomed out)
    camera_unit_screen_max: Math.min(window.innerWidth, window.innerHeight) - 30,           // Maximum zoom (fully zoomed in)
};

// Available primes and currently selected prime
var AVAILABLE_PRIMES = getAvailablePrimes();
var CURRENT_PRIME = 3;
var PRIME_REQUEST_STATE = RENDER_CORE.createPrimeRequestState(CURRENT_PRIME);

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
        schedulePointLabelZoomReflow();
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
        schedulePointLabelPosition(false);
    }
};

/* ===== GLOBAL ELEMENT REFERENCES ===== */

// SVG and group elements for the visualization
var svg_ss, g_svg, g_plot, g_bullets, g_strtlines, g_xaxis, g_yaxis;
var circle_mouseon, rect_selected, g_prod, div_menu_style;
var point_label, point_label_math, point_label_leader, div_menubar;
var bullet_selected = null;
var POINT_LABEL_STATE = {
    generation: 0,
    frame: null,
    zoomTimer: null,
    placement: null,
    visible: false,
    rechooseRequested: false,
};

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
    g_xaxis = document.getElementById("g_xaxis");
    g_yaxis = document.getElementById("g_yaxis");
    circle_mouseon = document.getElementById("circle_mouseon");
    rect_selected = document.getElementById("rect_selected");
    g_prod = document.getElementById("g_prod");
    point_label = document.getElementById("point_label");
    point_label_math = document.getElementById("point_label_math");
    point_label_leader = document.getElementById("point_label_leader");
    div_menubar = document.getElementById("div_menubar");
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
    updateAxisLabels();
    schedulePointLabelPosition(true);
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

// Cleanup function for pointer state
function cleanupPointerState() {
    pointerCache.length = 0;
    POINTER_CLICK_TRACKER.cancel();
    prevPt = null;
    prevPtsDist = null;
    isPointerActive = false;
    
    // Remove global listeners
    document.removeEventListener('pointerup', handleGlobalPointerUp);
    document.removeEventListener('pointercancel', handleGlobalPointerCancel);
}

// Global pointer event handlers for out-of-viewport release
function handleGlobalPointerUp(event) {
    finishPointer(event, false);
}

function handleGlobalPointerCancel(event) {
    finishPointer(event, false);
}

// Handle pointer down events (mouse down or touch start)
function on_pointerdown(event) {
    if (STATE === "start" && event.button === 0) { // Only handle left mouse button
        div_menu_style.visibility = "hidden"; // Hide context menu
        pointerCache.push(event);
        POINTER_CLICK_TRACKER.down(event.pointerId, event.clientX, event.clientY);

        // Track active pointer state
        isPointerActive = true;

        // Capture pointer to track movements outside element
        event.target.setPointerCapture(event.pointerId);

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
        POINTER_CLICK_TRACKER.move(event.pointerId, event.clientX, event.clientY);
        let index = 0;
        // Update the moving pointer in cache
        for (; index < pointerCache.length; index++) {
            if (event.pointerId === pointerCache[index].pointerId) {
                pointerCache[index] = event;
                break;
            }
        }

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

function updatePointerStateAfterRemoval() {
    if (pointerCache.length === 0) {
        prevPt = null;
        prevPtsDist = null;
        isPointerActive = false;
    } else if (pointerCache.length === 1) {
        prevPt = new Vector(pointerCache[0].clientX, pointerCache[0].clientY);
        prevPtsDist = null;
    } else if (pointerCache.length === 2) {
        prevPt = null;
        prevPtsDist = getDistPts();
    } else {
        prevPt = null;
        prevPtsDist = null;
    }
}

function finishPointer(event, allowActivation) {
    const clickResult = POINTER_CLICK_TRACKER.up(event.pointerId);
    if (!clickResult.removed) return;

    removeEvent(event.pointerId);
    updatePointerStateAfterRemoval();

    if (allowActivation && clickResult.activate) {
        const bullet = event.target;
        if (bullet.classList.contains("b")) select_bullet(bullet);
        else clearSelection();
    }

    if (pointerCache.length === 0) {
        document.removeEventListener('pointerup', handleGlobalPointerUp);
        document.removeEventListener('pointercancel', handleGlobalPointerCancel);
    }
}

// Handle pointer up events (mouse up or touch end)
function on_pointerup(event) {
    if (STATE === "start" && event.button === 0) {
        // Release pointer capture
        event.target.releasePointerCapture(event.pointerId);
        finishPointer(event, true);
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

function screenLayout(index) {
    const layout = ACTIVE_VIEW.layout(index);
    const svgPoint = camera.world2svg(new Vector(layout.x, layout.y));
    return {
        x: svgPoint.x,
        y: window.innerHeight - svgPoint.y,
        radius: layout.r * camera.unit_svg,
        worldRadius: layout.r,
    };
}

function pointLabelBounds() {
    const padding = CONFIG.point_label_viewport_padding;
    const left = CONFIG.margin_x + padding;
    const top = padding;
    return {
        left,
        top,
        right: Math.max(left, window.innerWidth - padding),
        bottom: Math.max(top, window.innerHeight - CONFIG.margin_y - padding),
    };
}

function pointLabelMenubarRect() {
    const rect = div_menubar.getBoundingClientRect();
    return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    };
}

function rectanglesIntersect(left, right) {
    return left.left < right.right && left.left + left.width > right.left &&
        left.top < right.bottom && left.top + left.height > right.top;
}

function pointLabelCandidateEnvelope(anchor, labelSize) {
    const maximumGap = Math.max(...CONFIG.point_label_gaps);
    const padding = CONFIG.point_label_collision_padding;
    const horizontal = anchor.radius + maximumGap + labelSize.width + padding;
    const vertical = anchor.radius + maximumGap + labelSize.height + padding;
    return {
        left: anchor.x - horizontal,
        top: anchor.y - vertical,
        right: anchor.x + horizontal,
        bottom: anchor.y + vertical,
    };
}

function pointLabelObstacles(selection, anchor, labelSize) {
    const envelope = pointLabelCandidateEnvelope(anchor, labelSize);
    const selectedTargets = new Set(selection.targets);
    const screenLayouts = new Array(ACTIVE_VIEW.count);
    const pointObstacles = [];

    for (let index = 0; index < ACTIVE_VIEW.count; index++) {
        const layout = screenLayout(index);
        screenLayouts[index] = layout;
        if (index === selection.index) continue;
        const radius = selectedTargets.has(index) ?
            layout.worldRadius * 1.7 * camera.unit_svg : layout.radius;
        if (
            layout.x + radius >= envelope.left &&
            layout.x - radius <= envelope.right &&
            layout.y + radius >= envelope.top &&
            layout.y - radius <= envelope.bottom
        ) {
            pointObstacles.push({x: layout.x, y: layout.y, radius});
        }
    }

    const segmentObstacles = [];
    ACTIVE_VIEW.forEachEdge(function(source, target) {
        const sourceLayout = screenLayouts[source];
        const targetLayout = screenLayouts[target];
        const width = Math.min(
            sourceLayout.worldRadius,
            targetLayout.worldRadius
        ) * camera.unit_svg / 4;
        if (
            Math.max(sourceLayout.x, targetLayout.x) + width / 2 >= envelope.left &&
            Math.min(sourceLayout.x, targetLayout.x) - width / 2 <= envelope.right &&
            Math.max(sourceLayout.y, targetLayout.y) + width / 2 >= envelope.top &&
            Math.min(sourceLayout.y, targetLayout.y) - width / 2 <= envelope.bottom
        ) {
            segmentObstacles.push({
                x1: sourceLayout.x,
                y1: sourceLayout.y,
                x2: targetLayout.x,
                y2: targetLayout.y,
                width,
            });
        }
    });
    return {pointObstacles, segmentObstacles};
}

function choosePointLabelPlacement(selection, anchor, labelSize) {
    const obstacles = pointLabelObstacles(selection, anchor, labelSize);
    return RENDER_CORE.chooseCalloutPlacement({
        anchor,
        labelSize,
        bounds: pointLabelBounds(),
        forbiddenRects: [pointLabelMenubarRect()],
        pointObstacles: obstacles.pointObstacles,
        segmentObstacles: obstacles.segmentObstacles,
        gaps: CONFIG.point_label_gaps,
        collisionPadding: CONFIG.point_label_collision_padding,
    });
}

function applyPointLabelPlacement(placement) {
    point_label.style.left = Math.round(placement.left) + "px";
    point_label.style.top = Math.round(placement.top) + "px";
    point_label_leader.setAttribute("x1", placement.leader.x1);
    point_label_leader.setAttribute("y1", placement.leader.y1);
    point_label_leader.setAttribute("x2", placement.leader.x2);
    point_label_leader.setAttribute("y2", placement.leader.y2);
    point_label_leader.setAttribute("visibility", "visible");
    point_label.style.visibility = "visible";
}

function translatedPointLabelPlacement(anchor, placement) {
    const deltaX = anchor.x - placement.anchorX;
    const deltaY = anchor.y - placement.anchorY;
    return Object.assign({}, placement, {
        left: anchor.x + placement.offsetX,
        top: anchor.y + placement.offsetY,
        anchorX: anchor.x,
        anchorY: anchor.y,
        leader: {
            x1: placement.leader.x1 + deltaX,
            y1: placement.leader.y1 + deltaY,
            x2: placement.leader.x2 + deltaX,
            y2: placement.leader.y2 + deltaY,
        },
    });
}

function pointLabelPlacementNeedsRechoose(placement) {
    const bounds = pointLabelBounds();
    if (
        placement.left < bounds.left ||
        placement.top < bounds.top ||
        placement.left + placement.width > bounds.right ||
        placement.top + placement.height > bounds.bottom
    ) {
        return true;
    }
    return rectanglesIntersect(placement, pointLabelMenubarRect());
}

function positionPointLabel(rechoose, generation) {
    if (
        generation !== POINT_LABEL_STATE.generation ||
        !POINT_LABEL_STATE.visible
    ) {
        return;
    }
    const selection = getSelectionLifecycle().current();
    if (selection === null || selection.datasetKey !== ACTIVE_VIEW.key) return;

    const anchor = screenLayout(selection.index);
    let placement;
    if (rechoose || POINT_LABEL_STATE.placement === null) {
        const labelRect = point_label.getBoundingClientRect();
        placement = choosePointLabelPlacement(selection, anchor, {
            width: labelRect.width,
            height: labelRect.height,
        });
        placement.anchorX = anchor.x;
        placement.anchorY = anchor.y;
    } else {
        placement = translatedPointLabelPlacement(
            anchor,
            POINT_LABEL_STATE.placement
        );
    }

    POINT_LABEL_STATE.placement = placement;
    applyPointLabelPlacement(placement);
    if (!rechoose && pointLabelPlacementNeedsRechoose(placement)) {
        schedulePointLabelPosition(true);
    }
}

function schedulePointLabelPosition(rechoose) {
    if (!POINT_LABEL_STATE.visible) return;
    POINT_LABEL_STATE.rechooseRequested =
        POINT_LABEL_STATE.rechooseRequested || rechoose;
    if (POINT_LABEL_STATE.frame !== null) return;
    const generation = POINT_LABEL_STATE.generation;
    POINT_LABEL_STATE.frame = requestAnimationFrame(function() {
        POINT_LABEL_STATE.frame = null;
        if (
            generation !== POINT_LABEL_STATE.generation ||
            !POINT_LABEL_STATE.visible
        ) {
            return;
        }
        const shouldRechoose = POINT_LABEL_STATE.rechooseRequested;
        POINT_LABEL_STATE.rechooseRequested = false;
        positionPointLabel(shouldRechoose, generation);
    });
}

function schedulePointLabelZoomReflow() {
    if (!POINT_LABEL_STATE.visible) return;
    if (POINT_LABEL_STATE.zoomTimer !== null) {
        clearTimeout(POINT_LABEL_STATE.zoomTimer);
    }
    const generation = POINT_LABEL_STATE.generation;
    POINT_LABEL_STATE.zoomTimer = setTimeout(function() {
        POINT_LABEL_STATE.zoomTimer = null;
        if (
            generation === POINT_LABEL_STATE.generation &&
            POINT_LABEL_STATE.visible
        ) {
            schedulePointLabelPosition(true);
        }
    }, CONFIG.point_label_zoom_reflow_delay);
}

function hidePointLabel() {
    POINT_LABEL_STATE.generation += 1;
    if (POINT_LABEL_STATE.frame !== null) {
        cancelAnimationFrame(POINT_LABEL_STATE.frame);
        POINT_LABEL_STATE.frame = null;
    }
    if (POINT_LABEL_STATE.zoomTimer !== null) {
        clearTimeout(POINT_LABEL_STATE.zoomTimer);
        POINT_LABEL_STATE.zoomTimer = null;
    }
    POINT_LABEL_STATE.placement = null;
    POINT_LABEL_STATE.visible = false;
    POINT_LABEL_STATE.rechooseRequested = false;
    if (point_label) {
        point_label.hidden = true;
        point_label.style.visibility = "hidden";
        point_label.removeAttribute("data-latex");
        point_label.removeAttribute("data-key");
        point_label.removeAttribute("data-index");
    }
    if (point_label_math) point_label_math.replaceChildren();
    if (point_label_leader) {
        point_label_leader.setAttribute("visibility", "hidden");
    }
}

function showPointLabel(selection) {
    POINT_LABEL_STATE.generation += 1;
    const generation = POINT_LABEL_STATE.generation;
    if (POINT_LABEL_STATE.frame !== null) {
        cancelAnimationFrame(POINT_LABEL_STATE.frame);
        POINT_LABEL_STATE.frame = null;
    }
    if (POINT_LABEL_STATE.zoomTimer !== null) {
        clearTimeout(POINT_LABEL_STATE.zoomTimer);
        POINT_LABEL_STATE.zoomTimer = null;
    }
    POINT_LABEL_STATE.placement = null;
    POINT_LABEL_STATE.rechooseRequested = false;

    const tex = selection.label;
    point_label.dataset.latex = tex;
    point_label.dataset.key = selection.datasetKey;
    point_label.dataset.index = String(selection.index);
    point_label_math.replaceChildren();
    try {
        if (!ROOT.katex || typeof ROOT.katex.render !== "function") {
            throw new Error("KaTeX runtime is unavailable");
        }
        ROOT.katex.render(tex, point_label_math, {
            displayMode: false,
            throwOnError: true,
            trust: false,
            strict: "error",
        });
    } catch (error) {
        point_label_math.textContent = tex;
        console.error("Could not typeset selected monomial label.", error);
    }

    point_label.hidden = false;
    point_label.style.visibility = "hidden";
    POINT_LABEL_STATE.visible = true;
    schedulePointLabelPosition(true);

    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function() {
            if (
                generation === POINT_LABEL_STATE.generation &&
                POINT_LABEL_STATE.visible
            ) {
                schedulePointLabelPosition(true);
            }
        });
    }
}

function getSelectionLifecycle() {
    if (SELECTION_LIFECYCLE === null) {
        SELECTION_LIFECYCLE = RENDER_CORE.createSelectionLifecycle({
            clear(selection) {
                if (selection !== null) selection.node.removeAttribute("fill");
                bullet_selected = null;
                rect_selected.setAttribute("x", "-1000");
                rect_selected.setAttribute("y", "-1000");
                g_prod.replaceChildren();
                hidePointLabel();
            },
            show(selection) {
                bullet_selected = selection.node;
                bullet_selected.setAttribute("fill", "red");
                rect_selected.setAttribute(
                    "x",
                    Math.round(bullet_selected.getAttribute("cx")) - 0.5
                );
                rect_selected.setAttribute(
                    "y",
                    Math.round(bullet_selected.getAttribute("cy")) - 0.5
                );

                for (const target of selection.targets) {
                    const layout = ACTIVE_VIEW.layout(target);
                    const circle = document.createElementNS(
                        "http://www.w3.org/2000/svg",
                        "circle"
                    );
                    circle.setAttribute("class", "p product-target");
                    circle.setAttribute("cx", layout.x);
                    circle.setAttribute("cy", layout.y);
                    circle.setAttribute("r", layout.r * 1.7);
                    circle.setAttribute("fill", "green");
                    circle.setAttribute("opacity", "0.7");
                    circle.dataset.key = ACTIVE_VIEW.key;
                    circle.dataset.i = target;
                    g_prod.appendChild(circle);
                }

                showPointLabel(selection);
            },
        });
    }
    return SELECTION_LIFECYCLE;
}

function clearSelection() {
    getSelectionLifecycle().clear();
}

// Select a bullet, display its canonical monomial, and highlight its products.
function select_bullet(bullet) {
    getSelectionLifecycle().select(
        ACTIVE_VIEW,
        bullet.dataset.key,
        parseInt(bullet.dataset.i, 10),
        bullet
    );
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
    
    // Get time info from current manifest entry
    const currentEntry = getManifestEntryForPrime(CURRENT_PRIME);
    if (currentEntry && currentEntry.generatedAt) {
        const formattedTime = formatTimestamp(currentEntry.generatedAt);
        message += `Last updated: ${formattedTime}`;
    } else {
        message += "Last updated: Unknown";
    }

    showCustomModal("About & Metadata", message);
}

// Show help dialog with navigation instructions
function showHelp() {
    const helpText = "Navigation:\n• Pan: Click and drag, or use the arrow keys\n• Zoom: Mouse wheel, pinch gesture, or +/- keys\n• Select: Click a dot to select it and show its canonical monomial name\n• Support: Black lines show the unlabeled union of multiplication support by x₀ and x₁ (classically a₀ and h₀)\n• Targets: Green dots show the selected dot’s product targets\n• Clear: Click chart space outside any dot, or select a different prime, to clear the selection, its name, and its product targets\n\nURL Parameters:\n• prime=3,5,7,11,13 - Select an odd prime\n• scale=2 - Set zoom level (larger values = more zoomed in)\n• x=10 - Set horizontal coordinate for the center viewport\n• y=5 - Set vertical coordinate for the center viewport\n\nExamples URLs:\n• unified_viewer.html?prime=5\n• unified_viewer.html?prime=3&scale=2&x=140&y=20\n• unified_viewer.html?prime=7&scale=0.5&x=500&y=40";
    
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
    clearSelection();
    g_bullets["black"].innerHTML = "";
    g_bullets["blue"].innerHTML = "";
    g_bullets["grey"].innerHTML = "";
    g_strtlines.innerHTML = "";
    circle_mouseon.setAttribute("cx", "-1000");
}

function appendRenderedNodes(view, nodes) {
    let bulletsHTML = "";
    for (const node of nodes) {
        const layout = node.layout;
        bulletsHTML += '<circle data-key="' + view.key + '" data-i="' + node.index + '" class="p b cw" cx="' + layout.x + '" cy="' + layout.y + '" r="' + layout.r + '"> </circle>';
    }
    if (bulletsHTML) {
        g_bullets["black"].insertAdjacentHTML("beforeend", bulletsHTML);
    }
}

function appendRenderedEdges(view, edges) {
    let linesHTML = "";
    for (const edge of edges) {
        const width = Math.min(edge.sourceLayout.r, edge.targetLayout.r) / 4;
        linesHTML += '<line class="p sl cw" data-key="' + view.key + '" data-source="' + edge.source + '" data-target="' + edge.target + '" x1="' + edge.sourceLayout.x + '" y1="' + edge.sourceLayout.y + '" x2="' + edge.targetLayout.x + '" y2="' + edge.targetLayout.y + '" stroke="black" stroke-width="' + width + '"> </line>';
    }
    if (linesHTML) {
        g_strtlines.insertAdjacentHTML("beforeend", linesHTML);
    }
}

function finalizeRenderedPlot(view, generation) {
    if (!RENDER_GENERATIONS.isActive(generation)) return;
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

function getPlotController() {
    if (PLOT_CONTROLLER === null) {
        PLOT_CONTROLLER = RENDER_CORE.createProgressivePlotController({
            generations: RENDER_GENERATIONS,
            batchSize: CONFIG.plot_batchSize,
            edgeBatchSize: Math.floor(CONFIG.plot_batchSize / 2),
            requestAnimationFrame(callback) { requestAnimationFrame(callback); },
            clear: clearPlot,
            appendNodes: appendRenderedNodes,
            appendEdges: appendRenderedEdges,
            finalize: finalizeRenderedPlot,
        });
    }
    return PLOT_CONTROLLER;
}

// Start the plotting process for a dataset
function Plot(view, generation) {
    getPlotController().start(view, generation);
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

// Switch to a different prime
function switchPrime(prime) {
    if (prime === PRIME_REQUEST_STATE.requestedPrime()) return;

    clearSelection();
    RENDER_CORE.updateUrlParams(prime, window);
    loadPrimeData(prime);
}

// Create the prime selection dropdown in the menubar
function createPrimeSelector() {
    const container = document.getElementById('div_menubar');
    container.innerHTML = '';
    AVAILABLE_PRIMES = getAvailablePrimes();
    
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
function ensureDataLoader() {
    if (DATA_LOADER === null) {
        DATA_LOADER = new DATA_LOADER_API.E2DataLoader(
            RENDER_CORE.viewerManifestWithDataBase(getRuntimeManifest())
        );
    }
    return DATA_LOADER;
}

async function loadPrimeData(prime) {
    const requestId = PRIME_REQUEST_STATE.start(prime);

    try {
        const view = await ensureDataLoader().load(prime);
        if (!PRIME_REQUEST_STATE.isActive(prime, requestId)) return;

        const renderGeneration = RENDER_GENERATIONS.begin(view.key);

        ACTIVE_VIEW = view;
        DATA_JSON = view;
        PRIME_REQUEST_STATE.commit(prime);
        CURRENT_PRIME = prime;
        clearPlot();
        
        // Update bounds based on actual data
        const bounds = calculateMaxBounds(view);
        CONFIG.x_max = bounds.x_max;
        CONFIG.y_max = bounds.y_max;
        CONFIG_DYNAMIC.camera_unit_screen_min = (window.innerWidth - CONFIG.margin_x) / (CONFIG.x_max + 1);
        
        // Update grid to match data bounds
        addGridLines();
        
        Plot(view, renderGeneration);
        createPrimeSelector();
        
        // Set default region
        setCameraToDefaultRegion(prime);
        
        // Update page title like original
        document.title = "Adams E₂ for S⁰ at prime " + prime;
        
        console.log("Loaded data for prime " + prime + ", bounds: x_max=" + CONFIG.x_max + ", y_max=" + CONFIG.y_max);
    } catch (error) {
        if (!PRIME_REQUEST_STATE.isActive(prime, requestId)) return;
        PRIME_REQUEST_STATE.fail(prime);
        RENDER_CORE.syncPrimeControls(CURRENT_PRIME, window, document);
        console.error("Data for prime " + prime + " could not be loaded.", error);
        alert("Data for prime " + prime + " is not available. Please check the compact data files.");
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
    PRIME_REQUEST_STATE = RENDER_CORE.createPrimeRequestState(CURRENT_PRIME);
    
    // Load initial prime data
    loadPrimeData(CURRENT_PRIME).then(function() {
        processUrlParams(params);
    });
    
    // Set up window resize handler
    window.addEventListener("resize", windowResize);
    
    console.log("Adams Spectral Sequence Unified Viewer initialized");
    console.log("Available primes: " + AVAILABLE_PRIMES);
    console.log("Current prime: " + CURRENT_PRIME);
}

// Initialize when the page loads
if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("load", initializeSystem);
}
