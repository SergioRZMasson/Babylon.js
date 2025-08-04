import type { Mesh } from "core/index";
import type { FunctionComponent } from "react";
import { StringifiedPropertyLine } from "shared-ui-components/fluent/hoc/propertyLines/stringifiedPropertyLine";

//<StringifiedPropertyLine key="EntityUniqueId" label="Unique ID" description="The unique id of the node." value={commonEntity.uniqueId} />

export const MeshGeneralProperties: FunctionComponent<{ context: Mesh }> = ({ context: mesh }) => {
    return (
        <>
            <StringifiedPropertyLine key={mesh.uniqueId} label="Vertices" description="The total number of vertices in the mesh." value={mesh.getTotalVertices()} />
            <StringifiedPropertyLine key={mesh.uniqueId} label="Faces" description="The total number of faces in the mesh." value={mesh.getTotalIndices() / 3} />
            <StringifiedPropertyLine
                key={mesh.uniqueId}
                label="Submeshes"
                description="The total number of submeshes in the mesh."
                value={mesh.subMeshes ? mesh.subMeshes.length : 0}
            />
        </>
    );
};
