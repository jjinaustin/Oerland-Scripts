// Set up click handlers for fake selects
document.addEventListener('DOMContentLoaded', function() {
    const fakeSelects = document.querySelectorAll('.premium-select-fake');
    const popup = document.getElementById('premium-filter-popup');
    const closeBtn = document.querySelector('.premium-popup-close');
    
    fakeSelects.forEach(select => {
        select.addEventListener('click', function() {
            // Show the premium popup
            popup.style.display = 'flex';
        });
    });
    
    // Close popup when clicking the X
    closeBtn.addEventListener('click', function() {
        popup.style.display = 'none';
    });
    
    // Close popup when clicking outside the content
    popup.addEventListener('click', function(e) {
        if (e.target === popup) {
            popup.style.display = 'none';
        }
    });
});

// Map configuration constants
const mapboxAccessToken = 'pk.eyJ1IjoiampheWFsYTMiLCJhIjoiY2w3MXh4NmZzMHB0aDNwcDZwOWl4amhiMSJ9.9Bz0N98VsQUGVuhrO4qV3Q';
const SUPABASE_URL = 'https://jgfbbxmzqtzhlkhxzghf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpnZmJieG16cXR6aGxraHh6Z2hmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzc2MzYxMTcsImV4cCI6MjA1MzIxMjExN30.Yi9TCX11PTg6V0j98kXU2AqtDSPr6fLNlj2wGnC9EqE';

// Cache settings
const CACHE_KEY = 'cached_routes_data';
const CACHE_EXPIRY = 3600000; // 1 hour in milliseconds
const DB_NAME = 'routes_cache';
const STORE_NAME = 'routes';

// Initialize Supabase client
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Set up Mapbox access token
mapboxgl.accessToken = mapboxAccessToken;

// Global variables
let allRoutes = [];
let loadedRouteIds = new Set(); // Keep track of which routes we've already loaded
let routeLayers = [];
let map;
let activePopup = null;
let is3DEnabled = false;
let isLoadingMore = false;
let viewportRoutesLoaded = false;

// Initialize IndexedDB
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        
        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'item_id' });
            }
        };
        
        request.onsuccess = function(event) {
            resolve(event.target.result);
        };
        
        request.onerror = function(event) {
            console.error("IndexedDB error:", event.target.error);
            reject(event.target.error);
        };
    });
}

// Cache route data in IndexedDB
async function cacheRoutes(routes) {
    try {
        const db = await initDB();
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        // Cache each route individually
        routes.forEach(route => {
            store.put(route);
        });
        
        // Also store timestamp
        localStorage.setItem('routes_timestamp', Date.now().toString());
        
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = (event) => reject(event.target.error);
        });
    } catch (error) {
        console.error("Error caching routes:", error);
        // Fall back to localStorage if IndexedDB fails
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                allRoutesData: routes,
                timestamp: Date.now()
            }));
        } catch (e) {
            console.warn("Failed to cache routes in localStorage:", e);
        }
    }
}

// Get cached routes from IndexedDB
async function getCachedRoutes() {
    try {
        // Check timestamp first
        const timestamp = localStorage.getItem('routes_timestamp');
        if (!timestamp || (Date.now() - parseInt(timestamp) > CACHE_EXPIRY)) {
            console.log("Cache expired, fetching fresh data");
            return null;
        }
        
        const db = await initDB();
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        
        return new Promise((resolve, reject) => {
            request.onsuccess = function(event) {
                const routes = event.target.result;
                if (routes && routes.length > 0) {
                    console.log(`Got ${routes.length} routes from IndexedDB cache`);
                    resolve(routes);
                } else {
                    resolve(null);
                }
            };
            
            request.onerror = function(event) {
                console.error("Error getting cached routes:", event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error("Error accessing IndexedDB cache:", error);
        
        // Fall back to localStorage cache
        try {
            const cachedData = localStorage.getItem(CACHE_KEY);
            if (cachedData) {
                const { allRoutesData, timestamp } = JSON.parse(cachedData);
                if (Date.now() - timestamp < CACHE_EXPIRY && allRoutesData && allRoutesData.length > 0) {
                    console.log(`Using ${allRoutesData.length} cached routes from localStorage fallback`);
                    return allRoutesData;
                }
            }
        } catch (e) {
            console.warn("Error accessing localStorage cache:", e);
        }
        
        return null;
    }
}

// Function to simplify route geometries for faster rendering
function simplifyGeoJSON(geojson, tolerance = 0.0001) {
    if (turf && geojson && geojson.geometry && geojson.geometry.coordinates) {
        try {
            // Only simplify if it's a LineString with many points
            if (geojson.geometry.type === 'LineString' && 
                geojson.geometry.coordinates.length > 500) {
                
                // Simplify the line while preserving shape
                const simplified = turf.simplify(geojson, {
                    tolerance: tolerance,
                    highQuality: false
                });
                
                return simplified;
            }
        } catch (e) {
            console.warn("Error simplifying GeoJSON:", e);
        }
    }
    return geojson;
}

// Check if a point is within the current viewport
function isPointInViewport(point) {
    if (!map || !point) return false;
    
    const bounds = map.getBounds();
    return bounds.contains(point);
}

// Create a custom 3D control
class TerrainControl {
    constructor() {
        this._container = document.createElement('div');
        this._container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
        
        // Create a single button
        this._button = document.createElement('button');
        this._button.className = 'terrain-control';
        this._button.type = 'button';
        this._button.textContent = '3D';
        
        // Add a star marker only visible to non-premium users
        const starMarker = document.createElement('span');
        starMarker.className = 'premium-star-marker';
        starMarker.setAttribute('data-o-anonymous', '1');
        starMarker.setAttribute('data-o-plan-content', 'yW1z6PmB');
        starMarker.style.position = 'absolute';
        starMarker.style.top = '-5px';
        starMarker.style.right = '-5px';
        starMarker.style.fontSize = '10px';
        starMarker.style.background = '#FFC107';
        starMarker.style.color = '#333';
        starMarker.style.borderRadius = '50%';
        starMarker.style.width = '14px';
        starMarker.style.height = '14px';
        starMarker.style.display = 'flex';
        starMarker.style.alignItems = 'center';
        starMarker.style.justifyContent = 'center';
        starMarker.innerHTML = '<span style="font-size: 10px;">⭐</span>';
        
        this._button.appendChild(starMarker);
        
        // Add event listener based on subscription status
        this._button.addEventListener('click', (e) => {
            // Check if the user has a premium subscription
            const hasPremium = !document.querySelector('[data-o-plan-content="VmAGPa9a"][style*="display: none"]');
            
            if (hasPremium) {
                // Premium user - toggle 3D
                this._toggleTerrain();
            } else {
                // Non-premium user - redirect to pricing
                window.location.href = 'http://www.oerland.co/pricing';
            }
        });
        
        this._container.appendChild(this._button);
    }

    onAdd(map) {
        this._map = map;
        return this._container;
    }

    onRemove() {
        this._container.parentNode.removeChild(this._container);
        this._map = undefined;
    }

    _toggleTerrain() {
        is3DEnabled = !is3DEnabled;
        
        if (is3DEnabled) {
            // Enable 3D terrain and tilt the map
            map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });
            // Set a 60-degree pitch for 3D view
            map.easeTo({
                pitch: 60,
                duration: 1000
            });
            this._button.style.backgroundColor = '#007BFF';
            this._button.style.color = 'white';
        } else {
            // Disable 3D terrain and reset to flat view
            map.setTerrain(null);
            // Reset pitch to 0
            map.easeTo({
                pitch: 0,
                duration: 1000
            });
            this._button.style.backgroundColor = '';
            this._button.style.color = '';
        }
    }
}

function createSlug(name) {
    return name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]+/g, '');
}

// Initialize the map on page load
window.onload = function() {
    console.log("Initializing map...");
    map = new mapboxgl.Map({
        container: 'map-container',
        style: 'mapbox://styles/jjayala3/cll52pbyy00iy01qs5wgt8eqy',
        center: [-82.0561791, 29.2180225],
        zoom: 4,
        pitch: 0, // Start with a flat view
        bearing: 0
    });

    // Fetch and display routes on map load
    map.on('load', () => {
        console.log("Map loaded, initializing 3D sources and fetching routes...");
        
        // Check if source already exists before adding
        if (!map.getSource('mapbox-dem')) {
            map.addSource('mapbox-dem', {
                'type': 'raster-dem',
                'url': 'mapbox://mapbox.mapbox-terrain-dem-v1',
                'tileSize': 512,
                'maxzoom': 14
            });
        }
        
        // Check if sky layer already exists before adding
        if (!map.getLayer('sky')) {
            map.addLayer({
                'id': 'sky',
                'type': 'sky',
                'paint': {
                    'sky-type': 'atmosphere',
                    'sky-atmosphere-sun': [0.0, 0.0],
                    'sky-atmosphere-sun-intensity': 15
                }
            });
        }
        
        // Start fetching routes
        fetchAndDisplayRoutes();
        
        // Add event to load more routes when the map is moved
        map.on('moveend', function() {
            if (viewportRoutesLoaded && !isLoadingMore) {
                loadMoreVisibleRoutes();
            }
        });
    });

    // Add navigation control (zoom +/- and rotation)
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    
    // Add geolocate control - allows users to locate themselves
    map.addControl(new mapboxgl.GeolocateControl({
        positionOptions: {
            enableHighAccuracy: true
        },
        trackUserLocation: true,
        showUserHeading: true
    }), 'top-right');
    
    // Add fullscreen control - allows user to toggle fullscreen
    map.addControl(new mapboxgl.FullscreenControl(), 'top-right');
    
    // Add custom 3D terrain control
    map.addControl(new TerrainControl(), 'top-right');
    
    // Add scale control - shows scale in imperial and metric
    map.addControl(new mapboxgl.ScaleControl({
        maxWidth: 100,
        unit: 'imperial'
    }), 'bottom-left');

    // Function to display routes on the map
    function displayRoutes(routes, isInitialLoad = false) {
        console.log(`Displaying ${routes.length} routes...`);
        
        if (isInitialLoad) {
            // Clear existing layers and sources
            const currentLayers = map.getStyle().layers.map(layer => layer.id);
            currentLayers.forEach(layerId => {
                if (layerId.startsWith('layer-') || layerId === 'routes' || layerId === 'route-clusters' || layerId === 'cluster-count' || layerId === 'unclustered-point') {
                    try {
                        map.removeLayer(layerId);
                    } catch (e) {
                        console.warn(`Failed to remove layer ${layerId}:`, e);
                    }
                }
            });

            // Remove sources
            ['routes', 'clusters', 'routes-cluster'].forEach(sourceId => {
                if (map.getSource(sourceId)) {
                    try {
                        map.removeSource(sourceId);
                    } catch (e) {
                        console.warn(`Failed to remove source ${sourceId}:`, e);
                    }
                }
            });

            // Reset route layers array
            routeLayers = [];
        }

        // Check if we have any routes to display
        if (routes.length === 0) {
            console.log("No routes to display");
            // Hide loading indicator
            document.getElementById('loading-indicator').style.display = 'none';
            return;
        }

        // Create a GeoJSON feature collection for the routes
        const features = [];

        console.log("Processing routes for display...");
        routes.forEach((route, index) => {
            // Skip routes we've already loaded
            if (loadedRouteIds.has(route.item_id)) {
                return;
            }
            
            // Mark this route as loaded
            loadedRouteIds.add(route.item_id);
            
            const geojson = route.geojson;
            const properties = geojson.properties;

            const distanceMiles = properties.distance * 0.621371;
            const elevationFt = properties.elevation_gain * 3.28084;
            const estimatedTime = properties.time;

            // Store the route data for later use
            routeLayers.push({
                id: `layer-${route.item_id}`,
                sourceId: `source-${route.item_id}`,
                geojson: geojson,
                properties: {
                    name: route.route_name,
                    distance: distanceMiles,
                    distanceKm: properties.distance,
                    time: estimatedTime,
                    itemId: route.item_id
                }
            });

            // For clustering, create point features
            if (geojson.geometry && geojson.geometry.coordinates && geojson.geometry.coordinates.length > 0) {
                // Get the center point of the route line
                let centerIndex = Math.floor(geojson.geometry.coordinates.length / 2);
                let centerPoint = geojson.geometry.coordinates[centerIndex];
                
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: centerPoint
                    },
                    properties: {
                        id: route.item_id,
                        name: route.route_name,
                        distance: properties.distance,
                        time: properties.time,
                        elevation_gain: properties.elevation_gain,
                        terrain: properties.terrain
                    }
                });
            }
        });
        
        // If we have no new routes to add, just return
        if (features.length === 0) {
            console.log("No new routes to add");
            document.getElementById('loading-indicator').style.display = 'none';
            return;
        }

        // If we have clusters already, update them
        if (map.getSource('routes-cluster')) {
            // Get existing features
            const existingData = map.getSource('routes-cluster')._data;
            const existingFeatures = existingData.features || [];
            
            // Combine with new features
            const combinedFeatures = [...existingFeatures, ...features];
            
            // Update the source
            map.getSource('routes-cluster').setData({
                type: 'FeatureCollection',
                features: combinedFeatures
            });
        } else {
            // Create a new clustered source
            map.addSource('routes-cluster', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: features
                },
                cluster: true,
                clusterMaxZoom: 12, // Max zoom to cluster points
                clusterRadius: 50, // Radius of each cluster when clustering points
                clusterMinPoints: 5 // Only create clusters when there are 5+ points
            });

            // Add cluster layers
            map.addLayer({
                id: 'route-clusters',
                type: 'circle',
                source: 'routes-cluster',
                filter: ['has', 'point_count'],
                paint: {
                    'circle-color': [
                        'step',
                        ['get', 'point_count'],
                        '#51bbd6', // Color for smaller clusters
                        10, '#DCF2EA', // Color for medium clusters
                        30, '#A3E6CD' // Color for large clusters
                    ],
                    'circle-radius': [
                        'step',
                        ['get', 'point_count'],
                        20, // Size for smaller clusters
                        10, 25, // Size for medium clusters
                        30, 30 // Size for large clusters
                    ]
                }
            });

            map.addLayer({
                id: 'cluster-count',
                type: 'symbol',
                source: 'routes-cluster',
                filter: ['has', 'point_count'],
                layout: {
                    'text-field': '{point_count_abbreviated}',
                    'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
                    'text-size': 12
                }
            });

            // Add individual points layer for unclustered points
            map.addLayer({
                id: 'unclustered-point',
                type: 'circle',
                source: 'routes-cluster',
                filter: ['!', ['has', 'point_count']],
                paint: {
                    'circle-color': '#11b4da',
                    'circle-radius': 6,
                    'circle-stroke-width': 1,
                    'circle-stroke-color': '#fff'
                }
            });

            // Handle clicks on clusters - show all routes immediately
            map.on('click', 'route-clusters', (e) => {
                console.log("Cluster clicked, showing all routes...");
                const features = map.queryRenderedFeatures(e.point, { layers: ['route-clusters'] });
                const clusterId = features[0].properties.cluster_id;
                
                // Get cluster children to show routes for this specific cluster
                map.getSource('routes-cluster').getClusterLeaves(
                    clusterId,
                    100, // Maximum number of routes to get
                    0,   // Offset
                    (err, clusterFeatures) => {
                        if (err) {
                            console.error("Error getting cluster leaves:", err);
                            return;
                        }
                        
                        console.log(`Found ${clusterFeatures.length} routes in this cluster`);
                        
                        // First, clear existing routes
                        clearRouteLines();
                        
                        // Then show all routes in this cluster
                        const clusterRouteIds = clusterFeatures.map(f => f.properties.id);
                        
                        const routesToShow = routeLayers.filter(route => 
                            clusterRouteIds.includes(route.properties.itemId)
                        );
                        
                        console.log(`Showing ${routesToShow.length} routes from this cluster`);
                        
                        // Add all routes from this cluster to the map
                        routesToShow.forEach(route => {
                            addRouteToMap(route);
                        });
                        
                        // Zoom to the cluster area (but don't zoom in further)
                        const clusterCoords = features[0].geometry.coordinates;
                        
                        // Create bounds to fit all routes in the cluster
                        const bounds = new mapboxgl.LngLatBounds();
                        
                        // Extend bounds to include all routes in the cluster
                        routesToShow.forEach(route => {
                            if (route.geojson && route.geojson.geometry && route.geojson.geometry.coordinates) {
                                route.geojson.geometry.coordinates.forEach(coord => {
                                    bounds.extend(coord);
                                });
                            }
                        });
                        
                        // Only fit bounds if we have points
                        if (!bounds.isEmpty()) {
                            map.fitBounds(bounds, {
                                padding: 50
                            });
                        } else {
                            // If bounds are empty (shouldn't happen), just center on the cluster
                            map.easeTo({
                                center: clusterCoords,
                                duration: 500
                            });
                        }
                    }
                );
            });

            // Handle clicks on unclustered points
            map.on('click', 'unclustered-point', (e) => {
                console.log("Individual point clicked, showing route and popup...");
                const props = e.features[0].properties;
                const coordinates = e.features[0].geometry.coordinates.slice();
                
                // Get route ID
                const routeId = props.id;
                
                // Show the specific route
                showSingleRoute(routeId);
                
                // Get additional properties
                const elevationFeet = (props.elevation_gain * 3.28084).toFixed(0);
                const elevationMeters = props.elevation_gain.toFixed(0);
                const distanceMiles = (props.distance * 0.621371).toFixed(2);
                const routeTerrain = props.terrain || 'Not specified';
                
                
                const htmlContent = `
                    <div class="popup-card">
                        <span class="close-btn" onclick="closePopup()">×</span>
                        <strong>${props.name}</strong>
                        <div class="route-stats">
                            <p><b>Distance:</b> ${distanceMiles} miles (${props.distance.toFixed(2)} km)</p>
                            <p><b>Estimated Time:</b> ${props.time.toFixed(1)} hours</p>
                            <p><b>Elevation Gain:</b> ${elevationFeet} ft (${elevationMeters} m)</p>
                            <p><b>Terrain:</b> ${routeTerrain}</p>
                            
                        </div>
                        <a href="https://oerland.co/route/${createSlug(props.name)}" target="_blank">View Full Details</a>
                    </div>
                `;

                if (activePopup) activePopup.remove();
                activePopup = new mapboxgl.Popup({ offset: 10 })
                    .setLngLat(coordinates)
                    .setHTML(htmlContent)
                    .addTo(map);
            });

            // Mouse enter/leave events for cursor style
            map.on('mouseenter', 'route-clusters', () => {
                map.getCanvas().style.cursor = 'pointer';
            });

            map.on('mouseleave', 'route-clusters', () => {
                map.getCanvas().style.cursor = '';
            });

            map.on('mouseenter', 'unclustered-point', () => {
                map.getCanvas().style.cursor = 'pointer';
            });

            map.on('mouseleave', 'unclustered-point', () => {
                map.getCanvas().style.cursor = '';
            });
        }

        // Hide loading indicator
        document.getElementById('loading-indicator').style.display = 'none';
    }

    // Load more routes that are visible in the current viewport
    async function loadMoreVisibleRoutes() {
        if (isLoadingMore) return;
        
        isLoadingMore = true;
        console.log("Loading more routes in current viewport...");
        
        // Get visible routes that we haven't loaded yet
        const visibleRoutes = allRoutes.filter(route => {
            if (loadedRouteIds.has(route.item_id)) return false;
            
            // Check if route is in viewport
            if (route.geojson && route.geojson.geometry && route.geojson.geometry.coordinates) {
                // Use the midpoint of the route to check
                const midIndex = Math.floor(route.geojson.geometry.coordinates.length / 2);
                const point = route.geojson.geometry.coordinates[midIndex];
                
                return isPointInViewport(point);
            }
            
            return false;
        });
        
        if (visibleRoutes.length > 0) {
            console.log(`Loading ${visibleRoutes.length} more visible routes`);
            displayRoutes(visibleRoutes);
        }
        
        isLoadingMore = false;
    }

    function applyFilters() {
        console.log("Applying filters to routes...");
        // Show loading indicator when applying filters
        document.getElementById('loading-indicator').style.display = 'flex';
        const distanceFilter = document.getElementById('distance-filter').value;
        const timeFilter = document.getElementById('time-filter').value;
        const elevationFilter = document.getElementById('elevation-filter').value;
        const terrainFilter = document.getElementById('terrain-filter').value;

        console.log(`Filters: distance=${distanceFilter}, time=${timeFilter}, elevation=${elevationFilter}, terrain=${terrainFilter}`);

        const filteredRoutes = allRoutes.filter(route => {
            const properties = route.geojson.properties;
            const distanceMiles = properties.distance * 0.621371;
            const elevationFt = properties.elevation_gain * 3.28084;
            const estimatedTime = properties.time;

            const distanceFilterPass =
                (distanceFilter === 'all') ||
                (distanceFilter === 'short' && distanceMiles < 20) ||
                (distanceFilter === 'medium' && distanceMiles >= 20 && distanceMiles <= 50) ||
                (distanceFilter === 'long' && distanceMiles > 50);

            const timeFilterPass =
                (timeFilter === 'all') ||
                (timeFilter === 'short' && estimatedTime < 1) ||
                (timeFilter === 'medium' && estimatedTime >= 1 && estimatedTime <= 3) ||
                (timeFilter === 'long' && estimatedTime > 3);

            const elevationFilterPass =
                (elevationFilter === 'all') ||
                (elevationFilter === 'low' && elevationFt < 500) ||
                (elevationFilter === 'medium' && elevationFt >= 500 && elevationFt <= 1000) ||
                (elevationFilter === 'high' && elevationFt > 1000);

            // More flexible terrain matching
            const terrainFilterPass =
                (terrainFilter === 'all') ||
                (terrainFilter === 'mixed' && (properties.terrain || '').toLowerCase() === 'mixed') ||
                (terrainFilter === 'offroad' && (properties.terrain || '').toLowerCase().includes('offroad')) ||
                (terrainFilter === 'asphalt' && (properties.terrain || '').toLowerCase().includes('asphalt'));

            return distanceFilterPass && timeFilterPass && elevationFilterPass && terrainFilterPass;
        });

        console.log(`Filtered routes: ${filteredRoutes.length} out of ${allRoutes.length}`);
        
        // Reset loaded route IDs
        loadedRouteIds = new Set();
        
        // Clear existing routes and display filtered ones
        clearRouteLines();
        
        // Display only the first batch of visible filtered routes
        const visibleRoutes = getVisibleRoutes(filteredRoutes, 20);
        displayRoutes(visibleRoutes, true);
        
        // Mark that we're done with initial viewport loading
        viewportRoutesLoaded = true;
    }

    // Get routes visible in the current viewport with an optional limit
    function getVisibleRoutes(routes, limit = 0) {
        const visibleRoutes = [];
        const bounds = map.getBounds();
        
        // First prioritize routes in the viewport
        for (const route of routes) {
            if (limit > 0 && visibleRoutes.length >= limit) break;
            
            // Check if route is in viewport
            if (route.geojson && route.geojson.geometry && route.geojson.geometry.coordinates) {
                // Use the midpoint of the route to check
                const midIndex = Math.floor(route.geojson.geometry.coordinates.length / 2);
                const point = route.geojson.geometry.coordinates[midIndex];
                
                if (bounds.contains(point)) {
                    visibleRoutes.push(route);
                }
            }
        }
        
        // If we still have room and need more routes, add some outside the viewport
        if (limit > 0 && visibleRoutes.length < limit) {
            for (const route of routes) {
                if (visibleRoutes.length >= limit) break;
                
                // Skip routes we've already added
                if (visibleRoutes.includes(route)) continue;
                
                visibleRoutes.push(route);
            }
        }
        
        return visibleRoutes;
    }

    async function fetchAllRoutes() {
        console.log("Querying Supabase for routes...");
        
        // Try to get cached routes first
        const cachedRoutes = await getCachedRoutes();
        if (cachedRoutes) {
            return cachedRoutes;
        }
        
        // Fetch from Supabase if no cache or expired
        const { data, error } = await supabaseClient
            .from('Routes')
            .select('*');

        if (error) {
            console.error("Error fetching routes from Supabase:", error);
            document.getElementById('loading-indicator').style.display = 'none';
            return [];
        }

        console.log(`Fetched ${data.length} routes from Supabase`);
        return data;
    }

    async function fetchAndDisplayRoutes() {
        try {
            console.log("Starting fetchAndDisplayRoutes...");
            
            // Get metadata about all routes from Supabase
            const supabaseRecords = await fetchAllRoutes();

            if (!supabaseRecords || supabaseRecords.length === 0) {
                console.warn("No routes fetched from Supabase.");
                document.getElementById('loading-indicator').style.display = 'none';
                return;
            }

            console.log(`Processing ${supabaseRecords.length} route records...`);
            document.querySelector('.loading-text').textContent = "Loading routes...";

            // Check if we have complete route data cached
            const cachedCompleteRoutes = await getCachedRoutes();
            if (cachedCompleteRoutes && cachedCompleteRoutes.length > 0) {
                console.log(`Using ${cachedCompleteRoutes.length} cached complete routes`);
                allRoutes = cachedCompleteRoutes;
                
                // Display only routes in the current viewport initially
                const initialRoutes = getVisibleRoutes(allRoutes, 20);
                displayRoutes(initialRoutes, true);
                viewportRoutesLoaded = true;
                return;
            }

            // No cache, fetch GeoJSON for each route
            // First fetch and display routes in the current viewport
            const viewportPromises = [];
            const otherPromises = [];
            
            // Create two groups of promises - viewport routes and other routes
            supabaseRecords.forEach((record, index) => {
                const route_name = record.route_name;
                const route_code = record.route_code;
                const item_id = record.item_id;

                if (!route_name || !route_code || !item_id) {
                    console.warn(`Skipping record ${index} due to missing fields`);
                    return;
                }

                // Create a promise to fetch this route
                const routePromise = fetch(route_code)
                    .then(response => {
                        if (!response.ok) {
                            throw new Error(`Failed to fetch GEOJSON from ${route_code}`);
                        }
                        return response.json();
                    })
                    .then(geojson => {
                        // Simplify complex routes
                        if (geojson.geometry && geojson.geometry.coordinates && 
                            geojson.geometry.coordinates.length > 500) {
                            geojson = simplifyGeoJSON(geojson, 0.0001);
                        }
                        return { route_name, route_code, geojson, item_id };
                    })
                    .catch(error => {
                        console.error(`Error fetching GEOJSON for route ${route_name}:`, error);
                        return null;
                    });
                
                // Determine if this route is likely in the viewport
                // This is just an estimate since we don't have coordinates yet
                // We'll prioritize US routes if we're centered on US
                const center = map.getCenter();
                const isUsRoute = route_name.includes('USA') || route_name.includes('Florida');
                const likelyInViewport = (center.lng < 0 && isUsRoute) || (center.lng > 0 && !isUsRoute);
                
                if (likelyInViewport) {
                    viewportPromises.push(routePromise);
                } else {
                    otherPromises.push(routePromise);
                }
            });

            // Process viewport routes first
            console.log(`Fetching ${viewportPromises.length} viewport routes first...`);
            const viewportResults = (await Promise.all(viewportPromises)).filter(route => route !== null);
            allRoutes = viewportResults;
            
            // Display the first batch immediately
            if (viewportResults.length > 0) {
                displayRoutes(viewportResults, true);
                
                // Cache what we have so far
                cacheRoutes(viewportResults);
            }
            
            // Then load the rest in the background
            console.log(`Fetching ${otherPromises.length} remaining routes in the background...`);
            document.querySelector('.loading-text').textContent = "Routes loaded! Loading more in background...";
            
            // Mark that we're done with initial viewport loading
            viewportRoutesLoaded = true;
            
            // Continue loading other routes in small batches
            const BATCH_SIZE = 10;
            for (let i = 0; i < otherPromises.length; i += BATCH_SIZE) {
                const batch = otherPromises.slice(i, i + BATCH_SIZE);
                const batchResults = (await Promise.all(batch)).filter(route => route !== null);
                
                if (batchResults.length > 0) {
                    // Add to all routes
                    allRoutes = [...allRoutes, ...batchResults];
                    
                    // Cache incrementally 
                    cacheRoutes(batchResults);
                    
                    // Only update display if we have visible routes and not applying filters
                    const visibleBatchRoutes = batchResults.filter(route => {
                        if (route.geojson && route.geojson.geometry && route.geojson.geometry.coordinates) {
                            // Use the midpoint of the route to check
                            const midIndex = Math.floor(route.geojson.geometry.coordinates.length / 2);
                            const point = route.geojson.geometry.coordinates[midIndex];
                            return isPointInViewport(point);
                        }
                        return false;
                    });
                    
                    if (visibleBatchRoutes.length > 0) {
                        displayRoutes(visibleBatchRoutes);
                    }
                }
                
                // Small delay to prevent browser from freezing
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            console.log(`Successfully processed ${allRoutes.length} routes total`);
            
            // Final cache update with all routes
            cacheRoutes(allRoutes);
            
            // Hide loading indicator if it's still showing
            document.getElementById('loading-indicator').style.display = 'none';
            
        } catch (error) {
            console.error("Error in fetchAndDisplayRoutes:", error);
            document.getElementById('loading-indicator').style.display = 'none';
        }
    }

    // Function to add a route to the map with hover effects
    function addRouteToMap(route) {
        console.log(`Adding route to map: ${route.id}`);
        
        // Don't re-add if already on the map
        if (map.getLayer(route.id)) {
            return;
        }
        
        // Add source if it doesn't exist
        if (!map.getSource(route.sourceId)) {
            map.addSource(route.sourceId, {
                type: 'geojson',
                data: route.geojson
            });
        }
        
        // Add the route line layer
        map.addLayer({
            id: route.id,
            type: 'line',
            source: route.sourceId,
            paint: {
                'line-color': '#000000',
                'line-width': 3,
                'line-opacity': 0.8
            }
        });
        
        // Add click handler for route
        map.on('click', route.id, (e) => {
            console.log(`Route clicked: ${route.properties.name}`);
            const coordinates = e.lngLat;
            
            // Get additional properties
            const props = route.geojson.properties;
            const distanceMiles = (props.distance * 0.621371).toFixed(2);
            const distanceKm = props.distance.toFixed(2);
            const elevationFeet = (props.elevation_gain * 3.28084).toFixed(0);
            const elevationMeters = props.elevation_gain.toFixed(0);
            const estimatedTime = props.time.toFixed(1);
            const routeTerrain = props.terrain || 'Not specified';
            const difficulty = props.difficulty || 'Not specified';
            
            const htmlContent = `
                <div class="popup-card">
                    <span class="close-btn" onclick="closePopup()">×</span>
                    <strong>${route.properties.name}</strong>
                    <div class="route-stats">
                        <p><b>Distance:</b> ${distanceMiles} miles (${distanceKm} km)</p>
                        <p><b>Estimated Time:</b> ${estimatedTime} hours</p>
                        <p><b>Elevation Gain:</b> ${elevationFeet} ft (${elevationMeters} m)</p>
                        <p><b>Terrain:</b> ${routeTerrain}</p>
                        <p><b>Difficulty:</b> ${difficulty}</p>
                    </div>
                    <a href="https://oerland.webflow.io/route/${createSlug(route.properties.name)}" target="_blank">View Full Details</a>
                </div>
            `;

            if (activePopup) activePopup.remove();
            activePopup = new mapboxgl.Popup({ offset: 10 })
                .setLngLat(coordinates)
                .setHTML(htmlContent)
                .addTo(map);
        });
        
        // Add hover effect for routes
        map.on('mouseenter', route.id, () => {
            map.getCanvas().style.cursor = 'pointer';
            map.setPaintProperty(route.id, 'line-color', '#FF6B6B'); // Highlight color on hover
            map.setPaintProperty(route.id, 'line-width', 5); // Make line thicker on hover
        });

        map.on('mouseleave', route.id, () => {
            map.getCanvas().style.cursor = '';
            map.setPaintProperty(route.id, 'line-color', '#000000'); // Reset to original color
            map.setPaintProperty(route.id, 'line-width', 3); // Reset to original width
        });
    }
    
    // Function to clear all route lines (but keep clusters)
    function clearRouteLines() {
        console.log("Clearing route lines");
        
        // Get all layers
        const layers = map.getStyle().layers;
        
        // Remove any route line layers
        layers.forEach(layer => {
            if (layer.id.startsWith('layer-')) {
                try {
                    map.removeLayer(layer.id);
                } catch (e) {
                    console.warn(`Failed to remove layer ${layer.id}:`, e);
                }
            }
        });
        
        // Remove any route sources
        const sources = Object.keys(map.getStyle().sources);
        sources.forEach(source => {
            if (source.startsWith('source-')) {
                try {
                    map.removeSource(source);
                } catch (e) {
                    console.warn(`Failed to remove source ${source}:`, e);
                }
            }
        });
    }
    
    // Function to show a single route
    function showSingleRoute(routeId) {
        console.log(`Showing single route: ${routeId}`);
        
        // Clear existing route lines
        clearRouteLines();
        
        // Find the route
        const route = routeLayers.find(route => route.properties.itemId === routeId);
        
        if (route) {
            addRouteToMap(route);
            
            // Fit map to the route
            if (route.geojson && route.geojson.geometry && route.geojson.geometry.coordinates) {
                const bounds = new mapboxgl.LngLatBounds();
                
                route.geojson.geometry.coordinates.forEach(coord => {
                    bounds.extend(coord);
                });
                
                if (!bounds.isEmpty()) {
                    map.fitBounds(bounds, {
                        padding: 50
                    });
                }
            }
        }
    }

    // Attach event listeners to filter elements
    document.getElementById('distance-filter').addEventListener('change', applyFilters);
    document.getElementById('time-filter').addEventListener('change', applyFilters);
    document.getElementById('elevation-filter').addEventListener('change', applyFilters);
    document.getElementById('terrain-filter').addEventListener('change', applyFilters);
};

function closePopup() {
    if (activePopup) {
        console.log("Closing active popup");
        activePopup.remove();
        activePopup = null;
    }
}

// Override Mapbox's default close button to use our custom styling
const mapboxPopupClass = mapboxgl.Popup;
mapboxgl.Popup = function(options) {
    options = options || {};
    options.closeButton = false; // Disable Mapbox's default close button
    return new mapboxPopupClass(options);
};

mapboxgl.Popup.prototype = mapboxPopupClass.prototype;
