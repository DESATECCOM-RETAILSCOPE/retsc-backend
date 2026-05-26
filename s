[33mcommit b4aa1798257f9b23bd09510983cc4f790d6a8d9d[m[33m ([m[1;36mHEAD[m[33m -> [m[1;32mmain[m[33m, [m[1;31morigin/main[m[33m, [m[1;31morigin/HEAD[m[33m)[m
Merge: 3405afa 32916a1
Author: Joel Tittles <128104185+JoelTR-22@users.noreply.github.com>
Date:   Tue May 26 13:09:51 2026 -0600

    Merge pull request #1 from DESATECCOM-RETAILSCOPE:Joe
    
    Joe

[33mcommit 32916a12ef8e3d220da9875919ca3543529f2c81[m[33m ([m[1;31morigin/Joe[m[33m)[m
Author: JoelTR-22 <joelramirez3112@gmail.com>
Date:   Mon May 25 09:40:30 2026 -0600

    .env example corregido

[33mcommit d37c1bcf4dc23dd214faadeb0d582119d0e7c2e5[m
Author: JoelTR-22 <joelramirez3112@gmail.com>
Date:   Mon May 25 09:36:56 2026 -0600

    Conexión a base de datos, eliminados .json mock

[33mcommit 47fe52cc5d360499944fb31150b3f60c2058b4df[m
Author: JoelTR-22 <joelramirez3112@gmail.com>
Date:   Wed May 20 13:19:00 2026 -0600

    Estado consolidado del backend
    Todo funcional y validado:
    
    Auth con JWT enriquecido
    Apertura de empresa
    6 endpoints de usuarios
    3 endpoints de categorías
    5 endpoints del pipeline de artículos (upload-excel, upload-images, process, status, list)
    Pipeline ejecutado end-to-end con validación GTIN, deduplicación, matching, jerarquía, blob mock, persistencia y tracking de IA

[33mcommit 3c38a598d582d0d23ece87c89d9f81f98b0fe89d[m
Author: JoelTR-22 <joelramirez3112@gmail.com>
Date:   Tue May 19 21:31:12 2026 -0600

    Backend administrativo completamente funcional y validado.

[33mcommit 24b2bf06efea4dda63e850717461bb98612d8198[m
Author: JoelTR-22 <joelramirez3112@gmail.com>
Date:   Tue May 19 20:48:52 2026 -0600

    feat: migrar persistencia de SQL Server a archivos JSON (temporal)
    
    - Agrega capa src/repositories/ con jsonRepo genérico y 10 repos específicos
    - Migra authService.js a userRepo (SQL original queda comentado para reactivar)
    - Agrega data/ con JSONs iniciales (roles, categorías) y seed demo
    - No se modifican controllers, routes ni middlewares

[33mcommit 3405afae0de91ac0f779a925a709f974d8713680[m
Author: quillito61 <84479428+quillito61@users.noreply.github.com>
Date:   Sun Apr 19 20:02:12 2026 -0600

    Inicial backend commit
