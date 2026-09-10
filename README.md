# Teselab-RSU · Visor Cartográfico de Residuos Urbanos (Archena)

Visor cartográfico web interactivo desarrollado por **Tesela Estudio** para la gestión e inventario de contenedores y papeleras del municipio de **Archena (Murcia)**, consumiendo datos en tiempo real mediante el estándar **OGC API - Features** servido desde QGIS Server / Mergin Maps.

---

## 🚀 Características principales

- **Visualización individual fluida**: Renderizado directo en Canvas de los contenedores sin agrupación (clusters), permitiendo inspeccionar cada punto individualmente con código de color por residuo (Resto, Vidrio, Papel/Cartón, Envases, Orgánico).
- **Control de saturación**: Mapa base al 40% de saturación por defecto para máxima legibilidad, con botón flotante de ajustes (`⚙️`) y control deslizante interactivo (0% a 200%).
- **Multi-capa base**: Selector integrado con Google Satélite, CartoDB Oscuro (Dark Matter), CartoDB Claro (Positron), PNOA Ortofoto (IGN España) y OpenStreetMap.
- **Red viaria y peatonal**: Generación dinámica con Turf.js de polígonos de calzada según el ancho métrico de cada tramo (`AN_CALZ`), junto con las zonas y plazas peatonales nativas.
- **Filtros dinámicos acumulativos**: Filtrado simultáneo por tipo de residuo, sistema de recogida, color del contenedor, técnico de campo y buscador por código.
- **Exportación a PDF**: Generación de informes resumen de elementos filtrados y fichas técnicas individuales con mapa de ubicación.
- **Vista Calendario**: Módulo preparado para el seguimiento de incidencias y revisiones en campo.
- **Diseño Glassmorphism Premium**: Interfaz moderna con tema oscuro, paneles translúcidos y completa responsividad móvil con controles táctiles inferiores (Bottom Sheets).

---

## 🛠️ Tecnologías

- **Leaflet.js** (v1.9.4)
- **Turf.js** (v6) para análisis espacial y cálculo geométrico de calzadas
- **OGC API - Features** (QGIS Server / Mergin Maps)
- **HTML5 Canvas / CSS3 Glassmorphism** (Google Fonts *Outfit* & *Plus Jakarta Sans*)

---

## 💻 Ejecución en local

Para pruebas locales con proxy CORS:

```bash
python proxy_server.py 3000
```

Abre tu navegador en `http://localhost:3000`.

---

© 2026 **Tesela Estudio** · [teselaestudio.com](https://teselaestudio.com)
