import requests
import random
import time
from faker import Faker
from datetime import datetime, timedelta, timezone
import uuid
import math
from typing import List, Tuple, Dict, Optional

# ---------------- Configuration ----------------
fake = Faker('el_GR')  # Greek locale for realistic data

ORION_BASE = "http://150.140.186.118:1026"
ORION_URL = f"{ORION_BASE}/v2/entities"
FIWARE_SERVICE_PATH = "/up1083865/thesis/Vehicles"
# Optional: set a tenant if your infra uses multi-tenancy, otherwise leave None
FIWARE_SERVICE_TENANT = None  # e.g., "up1083865"

BASE_ENTITY_ID = "urn:ngsi-ld:Vehicle:CIV"
ORGANIZATION_ID = "urn:ngsi-ld:PublicOrganization:CivilService"

HTTP_TIMEOUT = 15  # seconds

# Vehicle types for civil service
VEHICLE_TYPES = ["ambulance", "fire_truck", "police_car"]

# Contact types
CONTACT_TYPES = ["radio", "sms", "phone", "satellite"]

# Greek license plate prefixes for different regions
LICENSE_PREFIXES = ["ΥΧΑ", "ΧΑΝ", "ΘΕΣ", "ΠΑΤ", "ΗΡΑ", "ΚΟΡ", "ΛΑΡ", "ΒΟΛ"]

# Athens area fallback bounds (used if no roads loaded)
ATHENS_BOUNDS = {"lat_min": 37.8500, "lat_max": 38.0500, "lon_min": 23.6000, "lon_max": 23.8500}

# Major Greek cities with their coordinates
GREEK_CITIES: Dict[str, Dict[str, float]] = {
    "Athens":        {"lat": 37.9755, "lon": 23.7348},
    "Thessaloniki":  {"lat": 40.6401, "lon": 22.9444},
    "Patras":        {"lat": 38.2466, "lon": 21.7346},
    "Heraklion":     {"lat": 35.3387, "lon": 25.1442},
    "Larissa":       {"lat": 39.6390, "lon": 22.4194},
    "Volos":         {"lat": 39.3681, "lon": 22.9426},
    "Kavala":        {"lat": 40.9396, "lon": 24.4019},
    "Kalamata":      {"lat": 37.0392, "lon": 22.1142},
}

# ---- city distribution (lower Athens weight) ----
CITY_WEIGHTS: Dict[str, float] = {
    # "Athens": 0.5,         # ↓ fewer vehicles in Athens
    # "Thessaloniki": 0.30,   # ↑ more
    "Patras": 0.20,         # ↑ more
    # Add any of the other cities above if you also want vehicles there
    # "Heraklion": 0.10,
    # "Larissa": 0.10,
}

# Optional custom fetch radii per city (km)
CITY_RADII: Dict[str, float] = {
    # "Athens": 40,
    # "Thessaloniki": 30,
    "Patras": 12,
    # "Heraklion": 20,
    # "Larissa": 20,
    # "Volos": 20,
    # "Kavala": 20,
    # "Kalamata": 20,
}

STATIONS: Dict[str, Dict[str, List[Dict[str, float]]]] = {
    "ambulance": {
        "Patras": [
            {"name": "General Hospital Agios Andreas", "lon": 21.748008, "lat": 38.234512},
            {"name": "University Gen. Hospital of Patras (Rio)", "lon": 21.795547, "lat": 38.294240},
        ]
    },
    "fire_truck": {
        "Patras": [
            {"name": "Patras Fire Brigade HQ", "lon": 21.728747, "lat": 38.234359},
            {"name": "Pyrosvestio", "lon": 21.742785, "lat": 38.252295},
        ]
    },
    "police_car": {
        "Patras": [
            {"name": "B' police station", "lon": 21.737566, "lat": 38.245579},
            {"name": "A' police station", "lon": 21.754060, "lat": 38.261352},
        ]
    }
}


def _headers(content_type: Optional[str] = None) -> Dict[str, str]:
    h = {"Fiware-ServicePath": FIWARE_SERVICE_PATH}
    if content_type:
        h["Content-Type"] = content_type
    if FIWARE_SERVICE_TENANT:
        h["Fiware-Service"] = FIWARE_SERVICE_TENANT
    return h


# ---------------- Road network ----------------
class RoadNetworkManager:
    """Manages road network data and routing for vehicles (per-city aware)."""

    def __init__(self):
        # global pool of road polylines and per-city pools
        self.road_segments: List[List[Tuple[float, float]]] = []  # [(lon, lat), ...]
        self.city_segments: Dict[str, List[List[Tuple[float, float]]]] = {}  # city -> list of polylines
        self.vehicle_routes = {}

    def get_overpass_roads(self, bbox: Tuple[float, float, float, float]) -> List[List[Tuple[float, float]]]:
        """
        Fetch road data from OpenStreetMap using Overpass API.
        bbox: (min_lat, min_lon, max_lat, max_lon)
        Returns list of polylines with (lon, lat) tuples.
        """
        overpass_url = "http://overpass-api.de/api/interpreter"
        overpass_query = f"""
        [out:json][timeout:25];
        (
          way["highway"~"^(motorway|trunk|primary|secondary)$"]({bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]});
        );
        out geom;
        """

        try:
            resp = requests.post(overpass_url, data=overpass_query, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                roads = []
                for el in data.get('elements', []):
                    if el.get('type') == 'way' and 'geometry' in el:
                        pts = [(pt['lon'], pt['lat']) for pt in el['geometry']]
                        if len(pts) >= 2:
                            roads.append(pts)
                print(f"✅ Loaded {len(roads)} road segments from OpenStreetMap")
                return roads
            else:
                print(f"❌ Overpass API status {resp.status_code}: {resp.text[:120]}")
                return []
        except Exception as e:
            print(f"❌ Overpass API error: {e}")
            return []

    def _bbox_for_radius(self, center_lat: float, center_lon: float, radius_km: float) -> Tuple[float, float, float, float]:
        lat_off = radius_km / 111.0
        lon_off = radius_km / (111.0 * max(0.1, math.cos(math.radians(center_lat))))
        return (center_lat - lat_off, center_lon - lon_off, center_lat + lat_off, center_lon + lon_off)

    def load_roads_for_city(self, city_name: str, center_lat: float, center_lon: float, radius_km: float = 20):
        """Load roads for a specific city and store under that city's bucket."""
        bbox = self._bbox_for_radius(center_lat, center_lon, radius_km)
        segs = self.get_overpass_roads(bbox)
        if segs:
            self.road_segments.extend(segs)
            self.city_segments.setdefault(city_name, []).extend(segs)
        total = len(self.road_segments)
        city_total = len(self.city_segments.get(city_name, []))
        print(f"🏙️  {city_name}: +{len(segs)} segs (city total {city_total}) • Global total {total}")

    # Back-compat wrapper name (if you previously called load_roads_for_area)
    def load_roads_for_area(self, center_lat: float, center_lon: float, radius_km: float = 20):
        segs = self.get_overpass_roads(self._bbox_for_radius(center_lat, center_lon, radius_km))
        if segs:
            self.road_segments.extend(segs)
        print(f"📍 Total road segments available: {len(self.road_segments)}")

    def ensure_city_loaded(self, city_name: str):
        if self.city_segments.get(city_name):
            return
        data = GREEK_CITIES.get(city_name)
        if not data:
            return
        radius = CITY_RADII.get(city_name, 20)
        self.load_roads_for_city(city_name, data["lat"], data["lon"], radius)

    def get_nearest_road_point(self, lat: float, lon: float) -> Tuple[float, float]:
        """Find the nearest point (lon,lat) on the network to (lat,lon)."""
        if not self.road_segments:
            return (lon, lat)

        min_distance = float('inf')
        nearest_point = (lon, lat)

        for road in self.road_segments:
            skip = 1
            if 4 < len(road) < 10:
                skip = 2
            elif 10 <= len(road) < 100:
                skip = 3
            elif len(road) >= 100:
                skip = 10

            for i in range(0, len(road) - 1, skip):
                seg_pt = self._closest_point_on_segment(lon, lat, road[i][0], road[i][1], road[i+1][0], road[i+1][1])
                dist = self._haversine(lat, lon, seg_pt[1], seg_pt[0])
                if dist < min_distance:
                    min_distance = dist
                    nearest_point = seg_pt
        return nearest_point

    @staticmethod
    def _closest_point_on_segment(px: float, py: float, x1: float, y1: float, x2: float, y2: float) -> Tuple[float, float]:
        """Closest point (lon,lat) on segment (x1,y1)-(x2,y2) to (px,py)."""
        A, B = px - x1, py - y1
        C, D = x2 - x1, y2 - y1
        dot = A * C + B * D
        len_sq = C * C + D * D
        if len_sq == 0:
            return (x1, y1)
        t = max(0.0, min(1.0, dot / len_sq))
        return (x1 + t * C, y1 + t * D)

    @staticmethod
    def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        R = 6371.0
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = (math.sin(dlat/2)**2 +
             math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
             math.sin(dlon/2)**2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c  # km

    def get_random_road_point(self, city: Optional[str] = None) -> Tuple[float, float]:
        """Random point (lon,lat) on a road segment. If city provided & loaded, sample from that city."""
        segs = None
        if city:
            segs = self.city_segments.get(city)
            if not segs:
                # lazy load city if needed
                self.ensure_city_loaded(city)
                segs = self.city_segments.get(city)

        if not segs:
            segs = self.road_segments

        if not segs:
            # fallback: Athens box
            lat = random.uniform(ATHENS_BOUNDS["lat_min"], ATHENS_BOUNDS["lat_max"])
            lon = random.uniform(ATHENS_BOUNDS["lon_min"], ATHENS_BOUNDS["lon_max"])
            return (lon, lat)

        road = random.choice(segs)
        if len(road) < 2:
            return road[0]

        idx = random.randint(0, len(road) - 2)
        t = random.random()
        x1, y1 = road[idx]
        x2, y2 = road[idx+1]
        return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))


# ---------------- Helpers ----------------
def weighted_city_choice(weights: Dict[str, float]) -> str:
    """Pick a city name using the given weight map."""
    items = [(c, max(0.0, w)) for c, w in weights.items() if c in GREEK_CITIES]
    if not items:
        return "Athens"
    total = sum(w for _, w in items) or 1.0
    r = random.random() * total
    acc = 0.0
    for city, w in items:
        acc += w
        if r <= acc:
            return city
    return items[-1][0]


# ---------------- Simulator ----------------
class VehicleFleetSimulator:
    def __init__(self, num_vehicles=10):  # force 10 vehicles
        self.num_vehicles = 10
        self.vehicles: List[Dict] = []
        self.road_manager = RoadNetworkManager()
        self.seeded_mails = ["ktsambras@gmail.com", "ktsambras@gmail.com"]

        # Load ONLY Patras roads (as per CITY_WEIGHTS)
        print("🛣️  Loading road network by city (Patras)...")
        for city in CITY_WEIGHTS.keys():
            if city in GREEK_CITIES:
                lat = GREEK_CITIES[city]["lat"]
                lon = GREEK_CITIES[city]["lon"]
                radius = CITY_RADII.get(city, 12)
                self.road_manager.load_roads_for_city(city, lat, lon, radius)
        print(f"🗺️  Road segments loaded (global): {len(self.road_manager.road_segments)}")

    def _spawn_point_near_station(self, vehicle_type: str, city: str = "Patras", station: Optional[Dict[str, float]] = None) -> List[float]:
        stations = STATIONS.get(vehicle_type, {}).get(city, [])
        if not stations:
            lon, lat = self.road_manager.get_random_road_point(city)
            return [lon, lat]
        st = station if station else random.choice(stations)
        r_m = random.uniform(100.0, 400.0)
        theta = random.uniform(0.0, 2.0 * math.pi)
        lat_rad = math.radians(st["lat"])
        dlat = (r_m * math.cos(theta)) / 111_000.0
        dlon = (r_m * math.sin(theta)) / (111_000.0 * max(0.1, math.cos(lat_rad)))
        cand_lat = st["lat"] + dlat
        cand_lon = st["lon"] + dlon
        snap_lon, snap_lat = self.road_manager.get_nearest_road_point(cand_lat, cand_lon)
        return [snap_lon, snap_lat]

    def generate_road_coordinates(self, vehicle_type: str, city: str = "Patras", station: Optional[Dict[str, float]] = None) -> List[float]:
        return self._spawn_point_near_station(vehicle_type, city, station=station)


    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

    def generate_license_plate(self) -> str:
        prefix = random.choice(LICENSE_PREFIXES)
        number = random.randint(1000, 9999)
        return f"{prefix}-{number}"

    # def generate_road_coordinates(self, vehicle_type: str, city: str = "Patras") -> List[float]:
    #     return self._spawn_point_near_station(vehicle_type, city)

    def plan_station_spawns(self) -> List[Dict]:
        """
        Build a list of spawn specs like:
        { "vehicle_type": "ambulance", "city": "Patras", "station": {...} }
        ensuring >=1 and <=2 vehicles per station (Patras).
        """
        city = "Patras"

        # Flatten all stations (for Patras) across the three vehicle types you use
        station_specs = []
        for vtype in VEHICLE_TYPES:
            for st in STATIONS.get(vtype, {}).get(city, []):
                station_specs.append({"vehicle_type": vtype, "city": city, "station": st})

        if not station_specs:
            # Fallback: if no stations configured, return generic slots
            return [{"vehicle_type": random.choice(VEHICLE_TYPES), "city": city, "station": None}
                    for _ in range(self.num_vehicles)]

        # Ensure at least one per station
        spawns: List[Dict] = station_specs.copy()

        # Track count per station (use station name as key)
        counts: Dict[str, int] = {s["station"]["name"]: 1 for s in station_specs}

        # Fill remaining up to num_vehicles with max 2 per station
        remaining = max(0, self.num_vehicles - len(spawns))
        # Stations that can accept one more
        expandable = [s for s in station_specs if counts.get(s["station"]["name"], 0) < 2]

        while remaining > 0 and expandable:
            s = random.choice(expandable)
            name = s["station"]["name"]
            counts[name] = counts.get(name, 0) + 1
            spawns.append(s)
            remaining -= 1
            if counts[name] >= 2:
                # remove from expandable
                expandable = [x for x in expandable if x["station"]["name"] != name]

        # If still short (shouldn't happen unless num_vehicles > 2*stations), duplicate randomly
        while remaining > 0:
            spawns.append(random.choice(station_specs))
            remaining -= 1

        # If too many (num_vehicles < stations), trim while keeping at least one per station
        if len(spawns) > self.num_vehicles:
            # Guarantee one per station first, then trim extras
            base = station_specs.copy()
            extras = [s for s in spawns if s not in base]
            spawns = base[:]
            for e in extras:
                if len(spawns) >= self.num_vehicles: break
                # only add if that station is still <2
                nm = e["station"]["name"]
                if sum(1 for x in spawns if x["station"] and x["station"]["name"] == nm) < 2:
                    spawns.append(e)

        # Final trim in case of any edge cases
        return spawns[:self.num_vehicles]


    def move_vehicle_along_road(
        self,
        current_lon: float,
        current_lat: float,
        speed_kmh: float,
        time_delta_seconds: float = 15,
        city: Optional[str] = None
    ) -> Tuple[float, float]:
        """Move vehicle ~distance based on speed; bias to road points in the given city if provided."""
        distance_km = (speed_kmh * time_delta_seconds) / 3600.0
        if distance_km <= 0:
            return (current_lon, current_lat)

        nearest = self.road_manager.get_nearest_road_point(current_lat, current_lon)

        # Try to find a road point within a window around expected distance (biased to city)
        for _ in range(12):
            x, y = self.road_manager.get_random_road_point(city)
            d = self.road_manager._haversine(current_lat, current_lon, y, x)
            if 0.1 <= d <= max(0.2, distance_km * 2.5):
                return (x, y)

        return nearest  # fallback: snap to nearest

    def generate_phone_number(self) -> str:
        return f"+30-{random.randint(210, 299)}-{random.randint(1000000, 9999999)}"
    
    def generate_email(self) -> str:
        if len(self.seeded_mails) > 0:
            return self.seeded_mails.pop(0)
        return f"test-{random.randint(1000, 9999)}@test.com"

    def get_vehicle_capacity(self, vehicle_type: str) -> Dict[str, int]:
        capacities = {
            "ambulance": {"weight": 500, "crew": 3},
            "fire_truck": {"weight": 2000, "crew": 3},
            "police_car": {"weight": 300, "crew": 3},
            "patrol_car": {"weight": 200, "crew": 2},
            "rescue_vehicle": {"weight": 1500, "crew": 8},
            "utility_van": {"weight": 1200, "crew": 3},
            "command_vehicle": {"weight": 800, "crew": 5},
            "transport_truck": {"weight": 5000, "crew": 2},
            "maintenance_vehicle": {"weight": 2500, "crew": 4},
            "emergency_response": {"weight": 1000, "crew": 6}
        }
        return capacities.get(vehicle_type, {"weight": 1000, "crew": 3})

    def get_realistic_speed_for_vehicle(self, vehicle_type: str, road_type: str = "urban") -> float:
        base_speeds = {
            "ambulance": {"min": 50, "max": 90, "cruise": 70},
            "fire_truck": {"min": 40, "max": 80, "cruise": 60},
            "police_car": {"min": 60, "max": 120, "cruise": 80},
            "patrol_car": {"min": 30, "max": 70, "cruise": 50},
            "rescue_vehicle": {"min": 45, "max": 85, "cruise": 65},
            "utility_van": {"min": 40, "max": 90, "cruise": 70},
            "command_vehicle": {"min": 50, "max": 90, "cruise": 70},
            "transport_truck": {"min": 50, "max": 85, "cruise": 70},
            "maintenance_vehicle": {"min": 30, "max": 60, "cruise": 45},
            "emergency_response": {"min": 50, "max": 100, "cruise": 75}
        }
        speeds = base_speeds.get(vehicle_type, {"min": 30, "max": 80, "cruise": 60})
        if road_type == "highway":
            mult = 1.2
        elif road_type == "rural":
            mult = 1.0
        else:
            mult = 0.7
        min_s = max(0, speeds["min"] * mult)
        max_s = speeds["max"] * mult
        return round(random.triangular(min_s, max_s, speeds["cruise"] * mult), 1)

    def generate_vehicle_entity(self, vehicle_id: int, vehicle_type: Optional[str] = None, station: Optional[Dict[str, float]] = None) -> Dict:
        home_city = "Patras"
        vehicle_type = vehicle_type or random.choice(VEHICLE_TYPES)
        capacity_info = self.get_vehicle_capacity(vehicle_type)
        current_time = self._now()

        speed = self.get_realistic_speed_for_vehicle(vehicle_type)
        crew_onboard = random.randint(1, max(1, capacity_info["crew"] - 1))

        road_coordinates = self.generate_road_coordinates(vehicle_type, home_city, station=station)

        return {
            "id": f"{BASE_ENTITY_ID}-{vehicle_id:03d}",
            "type": "Vehicle",
            "vehicleType":   { "type": "Text",    "value": vehicle_type },
            "license_plate": { "type": "Text",    "value": self.generate_license_plate() },
            "owner":         { "type": "Text",    "value": ORGANIZATION_ID },
            "homeCity":      { "type": "Text",    "value": home_city },
            "contactPoint":  { "type": "StructuredValue", "value": { "email": self.generate_email(), "contactType": "email" } },
            "totalSeats":    { "type": "Integer", "value": capacity_info["crew"] },
            "crew":          { "type": "Integer", "value": crew_onboard },
            "occupiedSeats": { "type": "Integer", "value": crew_onboard },
            "location":      { "type": "geo:json", "value": { "type": "Point", "coordinates": road_coordinates } },
            "speed":         { "type": "Number",  "value": speed,
                            "metadata": { "unitCode": { "type":"Text","value":"KMH" },
                                            "timestamp": { "type":"DateTime","value": current_time } } },
            "status":        { "type": "Text",     "value": random.choice(["active","standby","maintenance","deployed"]) },
            "lastUpdated":   { "type": "DateTime", "value": current_time }
        }

    # -------------- Orion helpers --------------
    def check_and_create_entity(self, entity: Dict) -> bool:
        entity_id = entity["id"]
        try:
            r = requests.get(f"{ORION_URL}/{entity_id}", headers=_headers(), timeout=HTTP_TIMEOUT)
        except Exception as e:
            print(f"❌ GET error for {entity_id}: {e}")
            return False

        if r.status_code == 404:
            print(f"Entity {entity_id} not found. Creating entity...")
            try:
                c = requests.post(ORION_URL, headers=_headers("application/json"), json=entity, timeout=HTTP_TIMEOUT)
            except Exception as e:
                print(f"❌ POST error: {e}")
                return False
            if c.status_code == 201:
                print(f"✅ Created {entity_id}")
                return True
            print(f"❌ Create failed {c.status_code}: {c.text}")
            return False

        if r.status_code == 200:
            # Update existing entity (PATCH attrs)
            payload = {k: v for k, v in entity.items() if k not in ("id", "type")}
            try:
                u = requests.patch(
                    f"{ORION_URL}/{entity_id}/attrs",
                    headers=_headers("application/json"),
                    json=payload, timeout=HTTP_TIMEOUT
                )
            except Exception as e:
                print(f"❌ PATCH error: {e}")
                return False
            if u.status_code == 204:
                print(f"✅ Updated {entity_id}")
                return True
            print(f"❌ Update failed {u.status_code}: {u.text}")
            return False

        print(f"❌ Unexpected GET status {r.status_code}: {r.text}")
        return False

    def generate_and_post_fleet(self) -> int:
        print(f"🚗 Generating {self.num_vehicles} civil service vehicles on roads...")
        print(f"🎯 ServicePath: {FIWARE_SERVICE_PATH}")
        print("-" * 60)
        ok = 0

        spawns = self.plan_station_spawns()
        # Optional: print a quick summary
        summary = {}
        for s in spawns:
            key = (s["vehicle_type"], s["station"]["name"] if s["station"] else "None")
            summary[key] = summary.get(key, 0) + 1
        print("📌 Planned spawns (type @ station -> count):")
        for (vt, stname), cnt in summary.items():
            print(f"  - {vt} @ {stname}: {cnt}")

        for i, spawn in enumerate(spawns, start=1):
            try:
                entity = self.generate_vehicle_entity(i, vehicle_type=spawn["vehicle_type"], station=spawn["station"])
                self.vehicles.append(entity)
                if self.check_and_create_entity(entity):
                    ok += 1
                time.sleep(0.3)  # be gentle
            except Exception as e:
                print(f"❌ Error processing vehicle {i}: {e}")
        print("-" * 60)
        print(f"📊 Summary: {ok}/{self.num_vehicles} vehicles posted/updated")
        return ok


    def update_vehicle_status(self, vehicle_id: Optional[object] = None):
        """
        Update a random vehicle or a specific one. vehicle_id may be:
        - None (random)
        - an int (suffix number)
        - a full NGSI id string like 'urn:ngsi-ld:Vehicle:CIV-001'
        """
        if not self.vehicles:
            print("No vehicles generated yet. Run generate_and_post_fleet() first.")
            return

        # Select local entity
        if vehicle_id is None:
            vehicle = random.choice(self.vehicles)
        else:
            if isinstance(vehicle_id, str):
                vid = vehicle_id
            else:
                try:
                    vid = f"{BASE_ENTITY_ID}-{int(vehicle_id):03d}"
                except Exception:
                    vid = str(vehicle_id)
            vehicle = next((v for v in self.vehicles if v["id"] == vid), None)
            if not vehicle:
                print(f"Vehicle {vid} not found in local cache.")
                return

        current_time = self._now()
        coords = vehicle.get("location", {}).get("value", {}).get("coordinates", [23.7348, 37.9755])
        cur_lon, cur_lat = coords
        vtype = vehicle.get("vehicleType", {}).get("value", "patrol_car")
        home_city = vehicle.get("homeCity", {}).get("value")  # bias movement to city
        if random.random() < 0.5:
            new_speed = self.get_realistic_speed_for_vehicle(vtype)
        else:
            new_speed = 0

        new_lon, new_lat = self.move_vehicle_along_road(cur_lon, cur_lat, new_speed, city=home_city)

        updates = {
            "speed": {
                "type": "Number",
                "value": new_speed,
                "metadata": {
                    "unitCode":  { "type": "Text",     "value": "KMH" },
                    "timestamp": { "type": "DateTime", "value": current_time }
                }
            },
            "location": {
                "type": "geo:json",
                "value": { "type": "Point", "coordinates": [new_lon, new_lat] }
            },
            "status":      { "type": "Text",     "value": random.choice(["active","standby","maintenance","deployed"]) },
            "lastUpdated": { "type": "DateTime", "value": current_time }
        }

        try:
            resp = requests.patch(f"{ORION_URL}/{vehicle['id']}/attrs",
                                headers=_headers("application/json"),
                                json=updates, timeout=HTTP_TIMEOUT)
        except Exception as e:
            print(f"❌ PATCH error: {e}")
            return

        if resp.status_code == 204:
            print(f"✅ Moved {vehicle['id']} (Speed: {new_speed} km/h)")
            # Update local copy
            for k, v in updates.items():
                vehicle[k] = v
        else:
            print(f"❌ Failed to update {vehicle['id']}: {resp.status_code} - {resp.text}")

    def simulate_continuous_updates(self, duration_minutes: int = 10, update_interval: int = 30):
        print(f"🔄 Starting road-based simulation for {duration_minutes} minutes...")
        print(f"📡 Updates every {update_interval} seconds")
        end_time = datetime.now() + timedelta(minutes=duration_minutes)
        try:
            while datetime.now() < end_time:
                for vehicle in self.vehicles:
                    self.update_vehicle_status(vehicle["id"])  # works with string id now
                print(f"⏰ Next update in {update_interval} sec...")
                time.sleep(update_interval)
        except KeyboardInterrupt:
            print("\n🛑 Simulation interrupted.")
        print("🏁 Simulation completed.")

    def delete_all_vehicles(self):
        print("🗑️  Deleting all vehicle entities with base id prefix...")
        try:
            r = requests.get(f"{ORION_URL}?type=Vehicle&limit=999",
                            headers=_headers(), timeout=HTTP_TIMEOUT)
        except Exception as e:
            print(f"❌ GET error: {e}")
            return
        if r.status_code != 200:
            print(f"❌ Failed to list entities: {r.status_code} - {r.text}")
            return
        entities = r.json()
        to_delete = [e["id"] for e in entities if e.get("id", "").startswith(BASE_ENTITY_ID)]
        deleted = 0
        for eid in to_delete:
            try:
                d = requests.delete(f"{ORION_URL}/{eid}", headers=_headers(), timeout=HTTP_TIMEOUT)
            except Exception as e:
                print(f"❌ DELETE error for {eid}: {e}")
                continue
            if d.status_code == 204:
                print(f"✅ Deleted: {eid}")
                deleted += 1
                self.vehicles = [v for v in self.vehicles if v["id"] != eid]
            else:
                print(f"❌ Failed to delete {eid}: {d.status_code} - {d.text}")
        print(f"🧹 Deleted {deleted}/{len(to_delete)} matching vehicles.")

    def delete_specific_vehicles(self, vehicle_ids: List[int]):
        print("🗑️  Deleting specific vehicle entities...")
        deleted = 0
        for vid_num in vehicle_ids:
            eid = f"{BASE_ENTITY_ID}-{vid_num:03d}"
            try:
                d = requests.delete(f"{ORION_URL}/{eid}", headers=_headers(), timeout=HTTP_TIMEOUT)
            except Exception as e:
                print(f"❌ DELETE error for {eid}: {e}")
                continue
            if d.status_code == 204:
                print(f"✅ Deleted: {eid}")
                deleted += 1
                self.vehicles = [v for v in self.vehicles if v["id"] != eid]
            else:
                print(f"❌ Failed to delete {eid}: {d.status_code} - {d.text}")
        print(f"🧹 Successfully deleted {deleted}/{len(vehicle_ids)} requested vehicles.")

    def load_custom_area_roads(self, area_name: str):
        if area_name.lower() in [c.lower() for c in GREEK_CITIES.keys()]:
            city = next(c for c in GREEK_CITIES.keys() if c.lower() == area_name.lower())
            data = GREEK_CITIES[city]
            radius = CITY_RADII.get(city, 20)
            print(f"🏙️  Loading roads for {city}...")
            self.road_manager.load_roads_for_city(city, data["lat"], data["lon"], radius)
        else:
            print(f"❌ City '{area_name}' not found. Available: {', '.join(GREEK_CITIES.keys())}")


# ---------------- CLI ----------------
def main():
    print("🚨 Civil Service Vehicle Fleet Simulator - Road Edition (NGSI v2) 🚨")
    print("=" * 60)

    simulator = VehicleFleetSimulator(num_vehicles=10)

    while True:
        print("\n📋 Options:")
        print("1. Generate and post new fleet (on roads)")
        print("2. Delete all vehicle entities")
        print("3. Delete specific vehicles (by ID)")
        print("4. Run continuous road-based simulation")
        print("5. View current entities info")
        print("6. Load roads for specific Greek city")
        print("7. Show available cities")
        print("8. Exit")

        choice = input("\nSelect option (1-8): ").strip()

        if choice == '1':
            # Optional: purge existing
            try:
                r = requests.get(f"{ORION_URL}?type=Vehicle&limit=999", headers=_headers(), timeout=HTTP_TIMEOUT)
                if r.status_code == 200:
                    existing = [e for e in r.json() if e.get('id', '').startswith(BASE_ENTITY_ID)]
                    if existing:
                        print(f"⚠️  Found {len(existing)} existing vehicle entities.")
                        if input("Delete them first? (y/n): ").lower().strip() == 'y':
                            simulator.delete_all_vehicles()
                            print()
            except Exception:
                pass
            simulator.generate_and_post_fleet()

        elif choice == '2':
            if input("⚠️  Delete ALL vehicle entities? (yes/no): ").lower().strip() == 'yes':
                simulator.delete_all_vehicles()
            else:
                print("❌ Deletion cancelled.")

        elif choice == '3':
            try:
                ids_input = input("Enter vehicle IDs (comma-separated, e.g., 1,3,5): ").strip()
                vids = [int(x.strip()) for x in ids_input.split(',') if x.strip()]
                if vids:
                    simulator.delete_specific_vehicles(vids)
                else:
                    print("❌ No valid IDs provided.")
            except ValueError:
                print("❌ Invalid input. Please enter numeric IDs separated by commas.")

        elif choice == '4':
            if not simulator.vehicles:
                print("❌ No vehicles loaded. Generate fleet first (option 1).")
                continue
            try:
                duration = int(input("Duration in minutes (default 5): ") or "5")
                interval = int(input("Update interval in seconds (default 30): ") or "30")
                simulator.simulate_continuous_updates(duration, interval)
            except ValueError:
                print("❌ Invalid input. Using defaults 5 min / 30 sec.")
                simulator.simulate_continuous_updates()

        elif choice == '5':
            try:
                r = requests.get(f"{ORION_URL}?type=Vehicle&limit=999", headers=_headers(), timeout=HTTP_TIMEOUT)
                if r.status_code == 200:
                    entities = r.json()
                    vehicles = [e for e in entities if e.get('id', '').startswith(BASE_ENTITY_ID)]
                    print(f"\n📊 Found {len(vehicles)} vehicle entities:")
                    for e in vehicles[:10]:
                        vehicle_type = e.get('vehicleType', {}).get('value', 'unknown')
                        status = e.get('status', {}).get('value', 'unknown')
                        coords = e.get('location', {}).get('value', {}).get('coordinates', [0, 0])
                        home_city = e.get('homeCity', {}).get('value', '-')
                        print(f"  - {e['id']}: {vehicle_type} ({status}) at [{coords[0]:.4f}, {coords[1]:.4f}] • homeCity={home_city}")
                    if len(vehicles) > 10:
                        print(f"  ... and {len(vehicles) - 10} more")
                    print(f"\n🔗 {ORION_URL}?type=Vehicle&limit=999 (requires headers)")
                    print(f"🛣️  Service Path: {FIWARE_SERVICE_PATH}")
                    print(f"🗺️  Road segments loaded: {len(simulator.road_manager.road_segments)}")
                else:
                    print(f"❌ Failed to retrieve entities: {r.status_code} - {r.text}")
            except Exception as e:
                print(f"❌ Error retrieving entities: {e}")

        elif choice == '6':
            print("\n🏙️  Available Greek cities:")
            for city in GREEK_CITIES.keys():
                print(f"  - {city}")
            city_name = input("\nEnter city name: ").strip()
            if city_name:
                simulator.load_custom_area_roads(city_name)

        elif choice == '7':
            print("\n🏙️  Available Greek cities for road loading:")
            for i, (city, data) in enumerate(GREEK_CITIES.items(), 1):
                print(f"  {i}. {city} (lat: {data['lat']:.4f}, lon: {data['lon']:.4f})")
            print(f"\n🛣️  Currently loaded road segments: {len(simulator.road_manager.road_segments)}")

        elif choice == '8':
            print("👋 Goodbye!")
            break

        else:
            print("❌ Invalid option. Please select 1-8.")


if __name__ == "__main__":
    main()
