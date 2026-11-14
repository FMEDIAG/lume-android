# Tasaciones con evidencia real
- [x] Aceptar un precio comparable con página citada en monedas, con confianza mínima media y referencia directa; añadir regresión para 100 francos suizos.
- [x] Evitar confianza baja cuando hay precios del objeto verificados y conservar sus referencias, sin cambiar monedas ni Magic; 28 pruebas pasan y la vista compila sin errores.
- [x] Eliminar el retorno de tasaciones generales a cero y comprobar recuperación de extremos/divisas sin inventar mínimos.
- [x] Reducir esperas innecesarias en tasaciones generales y relojes, sin cambiar monedas ni Magic; 27 pruebas pasan y tasación real sin contexto comprobada (62 s, estimación sin evidencia por límites del buscador).
- [x] Corregir consultas por categoría y verificación de comparables.
- [x] Aplicar la evidencia a tasación general y numismática sin impedir tasar sin contexto.
- [x] Añadir pruebas y verificar una tasación real sin contexto (resultado orientativo, sin errores de pantalla).
- [x] Tasación más rápida: búsquedas con evidencia escalonadas en paralelo (12 s de margen por buscador) y modo de búsqueda de xAI recordado, sin cambiar monedas ni Magic.
- [ ] Verificar una tasación con precios de búsqueda en vivo: los buscadores devolvieron límites de cuota en la prueba.
